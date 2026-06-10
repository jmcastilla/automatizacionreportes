const path = require('path');
// Subimos un nivel (../) porque este archivo está dentro de la carpeta 'src'
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mssql = require('mssql');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const moment = require('moment');
const cron = require('node-cron');
const SEED_SECRET = process.env.SEED_SECRET;

// =========================================================================
// CONFIGURACIÓN SMTP OFICIAL DE MAILERSEND
// =========================================================================
const dispatcher = nodemailer.createTransport({
    host: "smtp.mailersend.net",
    port: 587,
    secure: false, // TLS
    auth: {
        user: "MS_0uDoAi@cargotronics.com",
        pass: "mssp.USE959X.z86org8vx6klew13.pWXxyKg",
    },
    tls: {
        rejectUnauthorized: false
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
// PROCESO PRINCIPAL DE ENVÍO AGALOPADO POR EMPRESA
// =========================================================================
async function ejecutarEnvioDeReportes() {
    console.log('=== [SMTP Mode] Iniciando recorrido de contratos por empresa ===');

    try {
        await mssql.connect(sqlConfig);

        // Tu consulta SQL avanzada
        const consulta = `
        SELECT
            con.ContractID AS [Contrato],
            con.PlacaTruck AS [Placa],
            con.ContainerNum AS [Contenedor],
        	  dev.DeviceID AS [Dispositivo],
            rt.DescripcionRuta AS [Ruta],
            DATEADD(HOUR, -5, dev.ICTime) AS [UltimoReporte],
            con.LastPositionGps AS [UltimaPosicion],
          	(CASE dev.Locked WHEN 1 THEN 'Cerrado' ELSE 'Abierto' END) AS [EstadoCandado],
          	tipr.TipoReporte AS [EstadoServ],
            con.LastReportUbica AS [UltimaValidacion],
            con.LastReportNota AS [Observacion],
            emp.NombreEmpresa AS [Empresa],
            con.FKICEmpresa,
            proy.DiferenciaHorariaM, proy.DiferenciaServidor,
            STUFF((
                  -- Añadimos DISTINCT y cambiamos el filtro por un IN
                  SELECT DISTINCT ';' + cnt.Mail
                  FROM dbo.LokContactos cnt
                  WHERE cnt.FKICEmpresa IN (con.FKICEmpresa, con.FKICEmpresaConsulta)
                    AND cnt.Autoreporte = 1
                    AND cnt.Mail IS NOT NULL AND cnt.Mail <> ''
                  FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 1, '') AS CorreosContactos
          FROM
              dbo.LokContractID con
              INNER JOIN LokDeviceID dev ON con.FKLokDeviceID = dev.DeviceID
              INNER JOIN ICRutas rt ON con.FKICRutas = rt.IdRuta
              INNER JOIN ICEmpresa emp ON con.FKICEmpresa = emp.IdEmpresa
              INNER JOIN LokProyectos proy ON con.FKLokProyecto = proy.IDProyecto
          	LEFT JOIN ICTipoReporte tipr ON TIPR.IdTipoReporte = CON.LastICTipoReporte
          WHERE
              con.Active = 1
              -- Condición: Que exista al menos un contacto con correo en cualquiera de las dos empresas
              AND EXISTS (
                  SELECT 1
                  FROM dbo.LokContactos cnt
                  WHERE cnt.FKICEmpresa IN (con.FKICEmpresa, con.FKICEmpresaConsulta, con.FKICEmpresaConsulta2, con.FKICEmpresaConsulta3)
                    AND cnt.Autoreporte = 1
                    AND cnt.Mail IS NOT NULL
                    AND cnt.Mail <> ''
              );
        `;

        const resultado = await mssql.query(consulta);
        const contratos = resultado.recordset;

        if (contratos.length === 0) {
            console.log('No se encontraron contratos activos para reportar.');
            return;
        }

        // =========================================================================
        // PASO 1: AGRUPAR LOS CONTRATOS POR EMPRESA (FKICEmpresa)
        // =========================================================================
        const empresasAgrupadas = {};

        contratos.forEach(contrato => {
            const idEmpresa = contrato.FKICEmpresa;
            // Si es la primera vez que vemos esta empresa, inicializamos su espacio
            if (!empresasAgrupadas[idEmpresa]) {
                empresasAgrupadas[idEmpresa] = {
                    nombreEmpresa: contrato.Empresa || 'Cliente',
                    listaContratos: [],
                    // Tomamos la cadena de correos (reemplazamos los puntos y comas por comas si los hay)
                    correos: contrato.CorreosContactos ? contrato.CorreosContactos.replace(/;/g, ', ') : null
                };
            }

            // Agregamos el contrato actual al lote de esta empresa
            empresasAgrupadas[idEmpresa].listaContratos.push(contrato);
        });

        console.log(`Se detectaron ${Object.keys(empresasAgrupadas).length} empresas distintas con reportes pendientes.`);

        // =========================================================================
        // PASO 2: RECORRER CADA EMPRESA Y ENVIAR SU CORREO CORRESPONDIENTE
        // =========================================================================
        for (const idEmpresa of Object.keys(empresasAgrupadas)) {
            const datosEmpresa = empresasAgrupadas[idEmpresa];

            if (!datosEmpresa.correos) {
                console.log(`⚠️ Empresa ID [${idEmpresa}] no tiene correos válidos configurados. Saltando...`);
                continue;
            }

            // Iniciamos la tabla limpia para esta empresa específica
            let filasTablaHtml = '';

            for (const contrato of datosEmpresa.listaContratos) {
                // Generamos el token criptográfico individual de 24 horas por contrato
                const payload = { contractId: contrato.Contrato, diffhorario: contrato.DiferenciaServidor, diffUTC: contrato.DiferenciaServidor, tipo: 'link_24h' };
                const token24h = jwt.sign(payload, SEED_SECRET, { expiresIn: '24h' });
                const urlConToken = `https://cargotronics.com/reportes-publicos?publicToken=${token24h}`;
                const fechaFormateada = moment(contrato.UltimoReporte).format('YYYY-MM-DD HH:mm:ss');
                // Construimos la fila agregando las nuevas columnas de tu consulta SQL
                filasTablaHtml += `
                    <tr style="border-bottom: 1px solid #eef0f3;">
                        <td style="padding: 12px; font-size: 13px; color: #555555;">${contrato.Placa || 'N/D'}</td>
                        <td style="padding: 12px; font-size: 13px; color: #555555;">${contrato.Contenedor || 'N/D'}</td>
                        <td style="padding: 12px; font-size: 13px; color: #555555;">${contrato.Dispositivo || 'N/D'}</td>
                        <td style="padding: 12px; font-size: 13px; color: #555555;">${contrato.Ruta || 'N/D'}</td>
                        <td style="padding: 12px; font-size: 13px; color: #555555;">${fechaFormateada || 'N/D'}</td>
                        <td style="padding: 12px; font-size: 13px; color: #555555; max-width: 150px; word-break: break-all;">${contrato.UltimaPosicion || 'N/D'}</td>
                        <td style="padding: 12px; font-size: 13px; color: #555555;">${contrato.EstadoCandado || 'N/D'}</td>
                        <td style="padding: 12px; font-size: 13px; color: #555555;">${contrato.EstadoServ || 'N/D'}</td>
                        <td style="padding: 12px; font-size: 13px; color: #555555; max-width: 150px; word-break: break-all;">${contrato.UltimaValidacion || 'N/D'}</td>
                        <td style="padding: 12px; font-size: 13px; color: #555555;">${contrato.Observacion || 'N/D'}</td>
                        <td style="padding: 12px; text-align: center;">
                            <a href="${urlConToken}" target="_blank" style="background-color: #003366; color: #ffffff; padding: 6px 12px; text-decoration: none; font-weight: bold; border-radius: 4px; font-size: 11px; display: inline-block;">Ver Reporte</a>
                        </td>
                    </tr>
                `;
            }

            // Armamos el cuerpo del correo con el diseño responsivo e inline
            const htmlCorreoCompleto = `
                <div style="font-family: Arial, sans-serif; max-width: 1250px; margin: 0 auto; border: 1px solid #eef0f3; padding: 25px; border-radius: 8px;">
                    <div style=" margin-bottom: 25px;">
                        <img src="https://static.wixstatic.com/media/9a4347_a8dbd9ccfecd4eb2b4239eadc7369c73~mv2.png/v1/fill/w_306,h_74,al_c,lg_1,q_85,enc_avif,quality_auto/logo-logiseguridad2-PNG.png"
                             alt="Logo Logiseguridad"
                             width="180"
                             style="display: inline-block; max-width: 100%; height: auto; border: 0;" />
                    </div>
                    <h2 style="color: #003366; margin-bottom: 10px;">Consolidado de Monitoreo Disponible</h2>
                    <p>Estimado Cliente <strong>${datosEmpresa.nombreEmpresa}</strong>,</p>
                    <p>A continuación, se detalla el listado actualizado de los contenedores y unidades bajo su operación que cuentan con seguimiento logístico activo en tiempo real:</p>

                    <table style="width: 100%; border-collapse: collapse; margin: 20px 0; text-align: left;">
                        <thead>
                            <tr style="background-color: #003366; color: #ffffff;">
                                <th style="padding: 12px; font-size: 13px;">Placa</th>
                                <th style="padding: 12px; font-size: 13px;">Contenedor</th>
                                <th style="padding: 12px; font-size: 13px;">Dispositivo</th>
                                <th style="padding: 12px; font-size: 13px;">Ruta</th>
                                <th style="padding: 12px; font-size: 13px;">Ultimo Reporte</th>
                                <th style="padding: 12px; font-size: 13px;">Última Posición</th>
                                <th style="padding: 12px; font-size: 13px;">Estado</th>
                                <th style="padding: 12px; font-size: 13px;">Estado Servicio</th>
                                <th style="padding: 12px; font-size: 13px;">Última Validación</th>
                                <th style="padding: 12px; font-size: 13px;">Observación</th>

                                <th style="padding: 12px; font-size: 13px; text-align: center;">Acceso Directo</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${filasTablaHtml}
                        </tbody>
                    </table>

                    <p style="background-color: #f4f6f9; padding: 12px; border-radius: 4px; font-size: 13px; border-left: 4px solid #003366; margin-top: 25px;">
                        ⚠️ <strong>Nota de seguridad:</strong> Cada uno de los enlaces de acceso generados en la tabla es estrictamente confidencial, individual y cuenta con una vigencia de seguridad de <strong>24 horas</strong>.
                    </p>

                    <hr style="border: 0; border-top: 1px solid #eef0f3; margin: 25px 0;">
                    <p style="font-size: 11px; color: #9aa0ac; margin: 0;">Plataforma automatizada de Cargotronics. Por favor no responda a este correo.</p>
                </div>
            `;

            // Enviar el correo al grupo de destinatarios de esta empresa en específico
            console.log(datosEmpresa.correos);
            await dispatcher.sendMail({
                from: `"${process.env.MAILERSEND_SENDER_NAME}" <${process.env.MAILERSEND_SENDER_EMAIL}>`,
                to: datosEmpresa.correos, // Nodemailer acepta múltiples correos separados por coma "email1@tld.com, email2@tld.com"
                subject: `📊 Reporte Consolidado de Monitoreo - Unidades Activas`,
                html: htmlCorreoCompleto
            });

            console.log(`✅ Email corporativo enviado con éxito a la empresa [ID: ${idEmpresa}] -> Destinatarios: (${datosEmpresa.correos})`);
        }

    } catch (errorGlobal) {
        console.error('💥 Error crítico en la ejecución del script:', errorGlobal.message);
    } finally {
        await mssql.close();
        console.log('=== Proceso finalizado. Conexión SQL cerrada. ===');
    }
}

cron.schedule('0 * * * *', () => {
    ejecutarEnvioDeReportes();
});

// Opcional: Descomenta la línea de abajo si quieres que se ejecute una vez de inmediato al arrancar el script
ejecutarEnvioDeReportes();

console.log('⏰ Planificador de reportes Cargotronics inicializado. Ejecutándose cada hora...');
