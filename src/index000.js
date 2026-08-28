const path = require('path');
// Subimos un nivel si es necesario para alcanzar el archivo .env
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mssql = require('mssql');
const axios = require('axios');

// =========================================================================
// CONFIGURACIÓN DE CONEXIÓN A SQL SERVER
// =========================================================================
const sqlConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    server: process.env.DB_SERVER,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    options: {
        encrypt: process.env.DB_ENCRYPT === 'true',
        trustServerCertificate: true
    }
};

// Crear el pool de conexión para la base de datos
const poolPromise = new mssql.ConnectionPool(sqlConfig)
    .connect()
    .then(pool => {
        console.log('✅ Conexión exitosa con SQL Server para WhatsApp Worker');
        return pool;
    })
    .catch(err => {
        console.error('💥 Error conectando a SQL Server:', err.message);
        process.exit(1);
    });

// =========================================================================
// CONFIGURACIÓN DE WHATSAPP CLOUD API
// =========================================================================
const token = "EAAOnqiiZC0yoBRi7KKnVZC5YUdJ5fSIZAlpLTZBQiFpRZClku65mVXceu7J70Iqt2vyqlQ1bcbUnaNlYUsjCa5jB7cQSARMfXVZAUeVICp6HAGJZA1ZCMQGFYYWT2VbrGSXGhYlR3Tn5FZBrTaZAwzPLxDf8vRue1tGi9CNR83cY2BxV2YHVNKrPIQsqI4AdHvHgZDZD";
const phoneNumberId = "1188880720969815";

// =========================================================================
// FUNCIONES DE CONTROL Y CONSULTAS
// =========================================================================

/**
 * 1. Envía el Template a la API de Meta
 */
function enviarReporteNovedades(telefono, placa, novedad, idReporte) {
    return axios.post(
        `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
        {
            messaging_product: "whatsapp",
            to: telefono,
            type: "template",
            template: {
                name: "alerta_despacho_operativo",
                language: { code: "es_CO" },
                components: [
                    {
                        type: "header",
                        parameters: [{ type: "text", text: placa }]
                    },
                    {
                        type: "body",
                        parameters: [{ type: "text", text: novedad }]
                    }
                ]
            }
        },
        {
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        }
    );
}

/**
 * 2. Consulta la lista de contactos usando el pool de forma segura
 */
async function ListaDeContacts(contrato, parametro, alerta) {
    try {
        const pool = await poolPromise;
        const request = pool.request();

        request.input('contrato', mssql.VarChar, contrato);

        const consulta = `
            SELECT DISTINCT ${parametro} AS param, AreaCode
            FROM dbo.Mails2(@contrato, 1, 1)
            WHERE ${alerta} = 1
        `;

        const resultado = await request.query(consulta);
        console.log(resultado.recordset);
        return resultado.recordset;
    } catch (error) {
        console.error("❌ Error en ListaDeContacts:", error.message);
        return [];
    }
}

/**
 * 3. Obtiene la notificación requerida (alertValue = 0)
 */
async function obtenerNotificacionPendiente() {
    try {
        const pool = await poolPromise;
        const request = pool.request();

        const consulta = `
        SELECT TOP (1)
        n.IdNotificacion,
        n.FkLokContractID,
        n.Notificacion,
        c.PlacaTruck
        FROM [infocarga].[dbo].[LokNotificaciones] AS n
        INNER JOIN [infocarga].[dbo].[LokContractID] as c on c.ContractID = n.FkLokContractID
        WHERE n.alertValue = 0 AND n.FkTipoNotificacion = 1 AND n.FKLokDeviceID = '7500313610' AND n.WhatsappSent=0
        ORDER BY n.IdNotificacion DESC
        `;

        const resultado = await request.query(consulta);
        return resultado.recordset.length > 0 ? resultado.recordset[0] : null;
    } catch (error) {
        console.error("❌ Error al obtener notificación:", error.message);
        return null;
    }
}

/**
 * 4. Cambia el estado de la notificación a 1 para que no se repita el envío
 */
async function marcarNotificacionComoEnviada(idNotificacion) {
    try {
        const pool = await poolPromise;
        const request = pool.request();
        request.input('id', mssql.Int, idNotificacion);

        await request.query(`
            UPDATE [infocarga].[dbo].[LokNotificaciones]
            SET WhatsappSent = 1
            WHERE IdNotificacion = @id
        `);
    } catch (error) {
        console.error(`❌ Error al actualizar alertValue para ID ${idNotificacion}:`, error.message);
    }
}

// =========================================================================
// PROCESO AUTOMÁTICO (ORQUESTADOR)
// =========================================================================
async function ejecutarCicloEnvio() {
    // Buscar la notificación en la BD
    const alertaPendiente = await obtenerNotificacionPendiente();

    if (!alertaPendiente) {
        console.log("📅 No hay notificaciones pendientes (alertValue=0).");
        return;
    }

    const { IdNotificacion, FkLokContractID, Notificacion, PlacaTruck } = alertaPendiente;
    console.log(`🚩 Procesando Notificación ID: ${IdNotificacion} para Contrato: ${FkLokContractID}`);

    try {
        // PLACA QUEMADA: Se define directamente como "EUM710" sin consultar a la tabla LokcontractID
        const placa = PlacaTruck;

        // Obtener los teléfonos destinatarios (Pasando "telefono" y "AperturaT_")
        const contactos = await ListaDeContacts(FkLokContractID, "telefono", "AperturaT");
        console.log(contactos);
        if (contactos.length === 0) {
            console.log(`⚠️ No se encontraron números con la alerta activa para el contrato: ${FkLokContractID}`);
            await marcarNotificacionComoEnviada(IdNotificacion);
            return;
        }
        let alMenosUnEnvioExitoso = false;
        // Enviar el WhatsApp a cada teléfono de la lista
        for (const contacto of contactos) {
            const numeroTelefono = contacto.AreaCode+""+contacto.param;
            if (!numeroTelefono) continue;

            console.log(`📱 Despachando WhatsApp a: ${numeroTelefono}`);
            try {
                // Esperamos la respuesta de la API de Meta
                await enviarReporteNovedades(
                    numeroTelefono,
                    placa,
                    Notificacion,
                    String(IdNotificacion)
                );
                console.log(`✅ WhatsApp enviado con éxito a ${numeroTelefono}`);
                alMenosUnEnvioExitoso = true; // Cambia a verdadero si Axios no lanza error
            } catch (apiError) {
                // Si falla un número individual, el bucle continúa con el siguiente
                console.error(`❌ Error enviando WhatsApp a ${numeroTelefono}:`, apiError.response?.data || apiError.message);
            }
        }

        // Actualizar base de datos para finalizar el flujo de esta alerta
        if (alMenosUnEnvioExitoso) {
            await marcarNotificacionComoEnviada(IdNotificacion);
            console.log(`🎉 Proceso completado exitosamente para la alerta ${IdNotificacion}.`);
        } else {
            console.error(`⚠️ No se pudo enviar el WhatsApp a ningún destinatario. Se reintentará en el próximo ciclo.`);
        }

    } catch (error) {
        console.error(`💥 Error procesando el flujo de WhatsApp para la alerta ${IdNotificacion}:`, error.message);
    }
}
//ejecutarCicloEnvio();
enviarReporteNovedades("573006624791", "KQT967", "APERTURA", 122);
// Revisa la Base de Datos automáticamente cada 30 segundos
//setInterval(ejecutarCicloEnvio, 30000);
