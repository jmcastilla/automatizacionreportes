const undici = require('undici');

if (!global.fetch) {
    global.fetch = undici.fetch;
    global.Headers = undici.Headers;
    global.Request = undici.Request;
    global.Response = undici.Response;
    global.FormData = undici.FormData;
    global.File = undici.File;
}
if (!global.Blob) {
    global.Blob = undici.Blob;
}

// Ahora sí continúa tu código normal...
require('dotenv').config();
const mssql = require('mssql');
const jwt = require('jsonwebtoken');
const { MailerSend, EmailParams, Sender, Recipient } = require("mailersend");

// =========================================================================
// CONFIGURACIÓN SEGURO USANDO PROCESO.ENV
// =========================================================================
const SEED_SECRET = process.env.SEED_SECRET;

const sqlConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    server: process.env.DB_SERVER,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    options: {
        // Convertimos el string 'true' a un booleano real
        encrypt: process.env.DB_ENCRYPT === 'true',
        trustServerCertificate: true
    }
};

const mailersend = new MailerSend({
    apiKey: process.env.MAILERSEND_API_KEY,
});

// =========================================================================
// PROCESO PRINCIPAL DE ENVÍO
// =========================================================================
async function ejecutarEnvioDeReportes() {
    console.log('=== Iniciando recorrido de contratos con Variables de Entorno ===');

    try {
        await mssql.connect(sqlConfig);

        const consulta = `
            SELECT c.ContractID, 'jmcastilla91@gmail.com' as CorreoCliente, c.PlacaTruck, c.NombreConductor
            FROM LokcontractID as c
            WHERE c.ContractID='SERV-00527424'
        `;
        const resultado = await mssql.query(consulta);
        console.log(resultado);
        const contratos = resultado.recordset;

        if (contratos.length === 0) {
            console.log('No se encontraron contratos activos con reporte automático.');
            return;
        }

        // Configurar el remitente usando los datos del .env
        const remitente = new Sender(
            process.env.MAILERSEND_SENDER_EMAIL,
            process.env.MAILERSEND_SENDER_NAME
        );

        for (const contrato of contratos) {
            try {
                if (!contrato.CorreoCliente) continue;

                // Generamos el token de 24 horas con el ContractID
                const payload = { contractId: contrato.ContractID, tipo: 'link_24h' };
                const token24h = jwt.sign(payload, SEED_SECRET, { expiresIn: '24h' });
                const urlConToken = `https://cargotronics.com/visualizar-reporte?publicToken=${token24h}`;

                const htmlCorreo = `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eef0f3; padding: 25px; border-radius: 8px;">
                        <h2 style="color: #003366; text-align: center;">Reporte de Monitoreo Disponible</h2>
                        <p>Estimado Cliente,</p>
                        <p>El reporte de seguimiento para el vehículo con placa <strong>${contrato.PlacaTruck || 'N/D'}</strong> ya está listo para su visualización.</p>
                        <div style="text-align: center; margin: 35px 0;">
                            <a href="${urlConToken}" target="_blank" style="background-color: #003366; color: #ffffff; padding: 14px 30px; text-decoration: none; font-weight: bold; border-radius: 5px; display: inline-block;">Ver Reporte en Tiempo Real</a>
                        </div>
                    </div>
                `;

                const destinatario = [
                    new Recipient(contrato.CorreoCliente, `Cliente Contrato #${contrato.ContractID}`)
                ];

                const emailParams = new EmailParams()
                    .setFrom(remitente)
                    .setTo(destinatario)
                    .setSubject(`📊 Monitoreo de Vehículo Activo - Contrato #${contrato.ContractID}`)
                    .setHtml(htmlCorreo);

                await mailersend.email.send(emailParams);
                console.log(`✅ Email enviado al Contrato #${contrato.ContractID}`);

            } catch (errorContrato) {
                console.error(`❌ Error en el Contrato #${contrato.ContractID}:`, errorContrato.message);
            }
        }

    } catch (errorGlobal) {
        console.error('💥 Error crítico:', errorGlobal.message);
    } finally {
        await mssql.close();
    }
}
ejecutarEnvioDeReportes();
//setInterval(ejecutarEnvioDeReportes, 60 * 60 * 1000);
