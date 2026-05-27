require('dotenv').config();
const mssql = require('mssql');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer'); // Cambiamos el SDK por nodemailer

const SEED_SECRET = process.env.SEED_SECRET;

// =========================================================================
// CONFIGURACIÓN SMTP OFICIAL DE MAILERSEND
// =========================================================================
const dispatcher = nodemailer.createTransport({
    host: "smtp.mailersend.net", // Servidor SMTP de MailerSend
    port: 587,
    secure: false, // TLS obligatorio
    auth: {
        // En MailerSend, tu usuario SMTP suele ser una dirección especial o tu usuario de cuenta
        // Revisa en tu panel de MailerSend -> Domains -> SMTP para confirmar tu usuario exacto.
        user: "MS_EW3h00@offertapp.co",
        pass: "mssp.P8219Fo.jpzkmgqrpz24059v.r7DhJst", // Tu API Key sirve directamente como contraseña SMTP
    },
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
// PROCESO PRINCIPAL DE ENVÍO
// =========================================================================
async function ejecutarEnvioDeReportes() {
    console.log('=== [SMTP Mode] Iniciando recorrido de contratos ===');

    try {
        await mssql.connect(sqlConfig);

        const consulta = `
            SELECT c.ContractID, 'jmcastilla91@gmail.com' as CorreoCliente, c.PlacaTruck, c.NombreConductor
            FROM LokcontractID as c
            WHERE c.ContractID = 'SERV-00527424'
        `;
        const resultado = await mssql.query(consulta);
        const contratos = resultado.recordset;

        if (contratos.length === 0) {
            console.log('No se encontraron contratos activos con reporte automático.');
            return;
        }

        console.log(`Procesando ${contratos.length} correos por SMTP...`);

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
                        <p>El reporte de seguimiento para el vehículo con placa <strong>${contrato.PlacaTruck || 'N/D'}</strong> (Conductor: ${contrato.NombreConductor || 'N/D'}) ya está listo para su visualización.</p>

                        <p style="background-color: #f4f6f9; padding: 12px; border-radius: 4px; font-size: 14px; border-left: 4px solid #003366;">
                            ⚠️ <strong>Nota de seguridad:</strong> Este enlace de acceso directo es estrictamente confidencial y tiene una vigencia de <strong>24 horas</strong>.
                        </p>

                        <div style="text-align: center; margin: 35px 0;">
                            <a href="${urlConToken}" target="_blank" style="background-color: #003366; color: #ffffff; padding: 14px 30px; text-decoration: none; font-weight: bold; border-radius: 5px; display: inline-block; font-size: 15px;">Ver Reporte en Tiempo Real</a>
                        </div>

                        <hr style="border: 0; border-top: 1px solid #eef0f3; margin: 25px 0;">
                        <p style="font-size: 11px; color: #9aa0ac; text-align: center; margin: 0;">Plataforma automatizada de Cargotronics. Por favor no responda a este correo.</p>
                    </div>
                `;

                // 4. ENVÍO DE CORREO TRADICIONAL
                await dispatcher.sendMail({
                    from: `"${process.env.MAILERSEND_SENDER_NAME}" <${process.env.MAILERSEND_SENDER_EMAIL}>`,
                    to: contrato.CorreoCliente,
                    subject: `📊 Monitoreo de Vehículo Activo - Contrato #${contrato.ContractID}`,
                    html: htmlCorreo
                });

                console.log(`✅ Email enviado con éxito al Contrato #${contrato.ContractID} (${contrato.CorreoCliente})`);

            } catch (errorContrato) {
                console.error(`❌ Error enviando correo para el Contrato #${contrato.ContractID}:`, errorContrato.message);
            }
        }

    } catch (errorGlobal) {
        console.error('💥 Error crítico en la ejecución del script:', errorGlobal.message);
    } finally {
        await mssql.close();
        console.log('=== Proceso finalizado. Conexión SQL cerrada. ===');
    }
}

ejecutarEnvioDeReportes();
