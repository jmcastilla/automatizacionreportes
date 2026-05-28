require('dotenv').config();
const mssql = require('mssql');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const SEED_SECRET = process.env.SEED_SECRET;

// =========================================================================
// CONFIGURACIÓN SMTP OFICIAL DE MAILERSEND
// =========================================================================
const dispatcher = nodemailer.createTransport({
    host: "smtp.mailersend.net",
    port: 587,
    secure: false, // TLS
    auth: {
        user: "MS_EW3h00@offertapp.co",
        pass: "mssp.P8219Fo.jpzkmgqrpz24059v.r7DhJst",
    },
    tls: {
        rejectUnauthorized: false // Evita problemas con nombres de servidor basados en IP
    }
});

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

// =========================================================================
// PROCESO PRINCIPAL DE ENVÍO (CONSOLIDADO EN TABLA)
// =========================================================================
async function ejecutarEnvioDeReportes() {
    console.log('=== [SMTP Mode] Iniciando recorrido de contratos ===');

    try {
        await mssql.connect(sqlConfig);

        // Tu consulta de prueba con múltiples contratos
        const consulta = `
            SELECT c.ContractID, 'jmcastilla91@gmail.com' as CorreoCliente, c.PlacaTruck, c.NombreConductor
            FROM LokcontractID as c
            WHERE c.ContractID IN ('SERV-00527424','SERV-00527363')
        `;
        const resultado = await mssql.query(consulta);
        const contratos = resultado.recordset;

        if (contratos.length === 0) {
            console.log('No se encontraron contratos activos para reportar.');
            return;
        }

        console.log(`Consolidando ${contratos.length} contratos en un único correo...`);

        // Tomamos el correo del primer registro para saber a quién enviarlo
        const correoDestinatario = contratos[0].CorreoCliente;

        // 1. Iniciamos la construcción de las filas de la tabla HTML
        let filasTablaHtml = '';

        for (const contrato of contratos) {
            // Generamos el token de 24 horas independiente para cada contrato
            const payload = { contractId: contrato.ContractID, tipo: 'link_24h' };
            const token24h = jwt.sign(payload, SEED_SECRET, { expiresIn: '24h' });
            const urlConToken = `https://cargotronics.com/visualizar-reporte?publicToken=${token24h}`;

            // Añadimos una fila (<tr>) por cada contrato a la tabla
            filasTablaHtml += `
                <tr style="border-bottom: 1px solid #eef0f3;">
                    <td style="padding: 12px; font-size: 14px; color: #333333;"><strong>${contrato.ContractID}</strong></td>
                    <td style="padding: 12px; font-size: 14px; color: #555555;">${contrato.PlacaTruck || 'N/D'}</td>
                    <td style="padding: 12px; font-size: 14px; color: #555555;">${contrato.NombreConductor || 'N/D'}</td>
                    <td style="padding: 12px; text-align: center;">
                        <a href="${urlConToken}" target="_blank" style="background-color: #003366; color: #ffffff; padding: 6px 12px; text-decoration: none; font-weight: bold; border-radius: 4px; font-size: 12px; display: inline-block;">Ver Reporte</a>
                    </td>
                </tr>
            `;
        }

        // 2. Armamos la estructura completa del cuerpo del correo inyectando las filas creadas
        const htmlCorreoCompleto = `
            <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; border: 1px solid #eef0f3; padding: 25px; border-radius: 8px;">
                <h2 style="color: #003366; text-align: center; margin-bottom: 10px;">Consolidado de Monitoreo Disponible</h2>
                <p>Estimado Cliente,</p>
                <p>A continuación, se detalla el listado de los vehículos y contratos que actualmente cuentan con reportes de seguimiento activos en tiempo real:</p>

                <table style="width: 100%; border-collapse: collapse; margin: 20px 0; text-align: left;">
                    <thead>
                        <tr style="background-color: #003366; color: #ffffff;">
                            <th style="padding: 12px; font-size: 14px;">Contrato</th>
                            <th style="padding: 12px; font-size: 14px;">Placa</th>
                            <th style="padding: 12px; font-size: 14px;">Conductor</th>
                            <th style="padding: 12px; font-size: 14px; text-align: center;">Acceso Directo</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${filasTablaHtml}
                    </tbody>
                </table>

                <p style="background-color: #f4f6f9; padding: 12px; border-radius: 4px; font-size: 13px; border-left: 4px solid #003366; margin-top: 25px;">
                    ⚠️ <strong>Nota de seguridad:</strong> Cada uno de los enlaces de acceso generados en la tabla es confidencial, individual y cuenta con una vigencia estricta de <strong>24 horas</strong> a partir de la emisión de este mensaje.
                </p>

                <hr style="border: 0; border-top: 1px solid #eef0f3; margin: 25px 0;">
                <p style="font-size: 11px; color: #9aa0ac; text-align: center; margin: 0;">Plataforma automatizada de Cargotronics. Por favor no responda a este correo.</p>
            </div>
        `;

        // 3. ENVIAMOS EL ÚNICO CORREO CON LA TABLA ADENTRO
        await dispatcher.sendMail({
            // Recuerda configurar el sender email de tu dominio verificado en el .env (alertas@offertapp.co)
            from: `"${process.env.MAILERSEND_SENDER_NAME}" <${process.env.MAILERSEND_SENDER_EMAIL}>`,
            to: correoDestinatario,
            subject: `📊 Reporte Consolidado de Monitoreo - Vehículos Activos`,
            html: htmlCorreoCompleto
        });

        console.log(`\n✅ Email consolidado enviado con éxito a: ${correoDestinatario} con ${contratos.length} contratos.`);

    } catch (errorGlobal) {
        console.error('💥 Error crítico en la ejecución del script:', errorGlobal.message);
    } finally {
        await mssql.close();
        console.log('=== Proceso finalizado. Conexión SQL cerrada. ===');
    }
}

ejecutarEnvioDeReportes();
