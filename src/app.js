const path = require('path');
// Subimos un nivel (../) porque este archivo está dentro de la carpeta 'src'
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const express = require('express');
const mssql = require('mssql');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const axios = require('axios'); // Requerido para el endpoint de Visual Logistic
const moment = require('moment');
const app = express();
const PORT = process.env.PORT || 3005;

const { enviarReportePorContrato } = require('./index');

// Configuración simulada u obtenida de variables para Visual Logistic
const Configuracion = {
    URL_VISUALLOGISTIC: process.env.URL_VISUALLOGISTIC || "visuallogisticsapp" // Ajusta según tu configuración
};

// =========================================================================
// MIDDLEWARES (Configuraciones de la App)
// =========================================================================
const whitelist = ['http://localhost:3000', 'https://cargotronics.com', 'https://infocarga-frontend-jwt-theta.vercel.app'];

app.use(cors({
    origin: function (origin, callback) {
        // Permitir peticiones sin origen (como apps móviles, Postman o herramientas del sistema)
        if (!origin) return callback(null, true);

        if (whitelist.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('No permitido por CORS'));
        }
    },
    credentials: true // <-- Esto soluciona el error permitiendo el modo 'include'
}));

app.use(express.json()); // Permite que la API reciba datos en formato JSON

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
        trustServerCertificate: true // Crucial para conexiones de desarrollo/IPs
    }
};

// Crear un pool global para reutilizar la conexión en toda la app
const poolPromise = new mssql.ConnectionPool(sqlConfig)
    .connect()
    .then(pool => {
        console.log('✅ Conexión exitosa con SQL Server');
        return pool;
    })
    .catch(err => {
        console.error('💥 Error conectando a SQL Server:', err.message);
        process.exit(1);
    });


const sqlConfig2 = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE_REP,
    server: process.env.DB_SERVER,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    options: {
        encrypt: process.env.DB_ENCRYPT === 'true',
        trustServerCertificate: true // Crucial para conexiones de desarrollo/IPs
    }
};

// Crear un pool global para reutilizar la conexión en toda la app
const poolPromise2 = new mssql.ConnectionPool(sqlConfig2)
    .connect()
    .then(pool => {
        console.log('✅ Conexión exitosa con SQL Server');
        return pool;
    })
    .catch(err => {
        console.error('💥 Error conectando a SQL Server:', err.message);
        process.exit(1);
    });

// =========================================================================
// MIDDLEWARE DE SEGURIDAD: VERIFICACIÓN DEL TOKEN DE 24 HORAS (HEADERS)
// =========================================================================
const verificarToken24h = (req, res, next) => {
    try {
        let token = req.headers.authorization;

        if (!token) {
            return res.json({ success: false, message: 'Token is missing' });
        }

        // Extraer el token quitando la palabra 'Bearer '
        token = token.split(' ')[1];

        // Validamos usando el secreto del archivo .env
        jwt.verify(token, process.env.SEED_SECRET, (err, decoded) => {
            if (err || decoded.tipo !== 'link_24h') {
                return res.json({ success: false, message: 'Failed to authenticate token' });
            }

            // BLINDAJE DE SEGURIDAD: Extraemos el contrato real guardado matemáticamente en el token.
            // De esta forma, el usuario en el frontend NO puede alterar el número de contrato en el body.
            req.contratoIdVerificado = decoded.contractId;
            req.diffhorario= decoded.diffhorario;
            req.diffUTC = decoded.diffUTC;
            req.tokenDecoded = decoded;
            next(); // El token es correcto, pasamos al endpoint original
        });

    } catch (error) {
        return res.json({ success: false, message: 'Internal auth error' });
    }
};

// =========================================================================
// ENDPOINT ORIGINAL: CONSULTAR INFORMACIÓN INICIAL DESDE LA URL (BODY)
// =========================================================================
app.post('/api/reportes/consultar-token', async (req, res) => {
    try {
        const { publicToken } = req.body;

        if (!publicToken) {
            return res.status(400).json({
                success: false,
                message: 'El token de acceso es requerido.'
            });
        }

        let datosToken;
        try {
            datosToken = jwt.verify(publicToken, process.env.SEED_SECRET);
        } catch (jwtError) {
            return res.status(403).json({
                success: false,
                message: 'El enlace ha expirado (límite de 1 hora superado) o es inválido.'
            });
        }

        if (datosToken.tipo !== 'link_24h' || !datosToken.contractId) {
            return res.status(403).json({
                success: false,
                message: 'Estructura de token no autorizada.'
            });
        }

        const idContratoExtraido = datosToken.contractId;
        console.log(`🔓 Acceso inicial autorizado para el contrato: ${idContratoExtraido}`);

        const pool = await poolPromise;
        const request = pool.request();
        request.input('contractId', mssql.VarChar, idContratoExtraido);

        const consultaSql = `
            SELECT c.ContractID, c.PlacaTruck, c.NombreConductor, c.Active
            FROM LokcontractID as c
            WHERE c.ContractID = @contractId
        `;

        const resultadoDb = await request.query(consultaSql);

        if (resultadoDb.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'El contrato asociado a este enlace ya no existe en el sistema.'
            });
        }

        const datosContrato = resultadoDb.recordset[0];

        res.json({
            success: true,
            message: 'Acceso concedido exitosamente.',
            data: {
                contrato: datosContrato.ContractID,
                placa: datosContrato.PlacaTruck,
                conductor: datosContrato.NombreConductor,
                activo: datosContrato.Active
            }
        });

    } catch (errorGlobal) {
        console.error('💥 Error en el endpoint:', errorGlobal.message);
        res.status(500).json({
            success: false,
            message: 'Ocurrió un error interno en el servidor.'
        });
    }
});

// =========================================================================
// NUEVOS ENDPOINTS PROTEGIDOS POR EL MIDDLEWARE (TOKEN EN HEADERS)
// =========================================================================

// 1. OBTENER FOTOS DEL CONTRATO
app.post('/api/reportes/fotos-contrato', verificarToken24h, async (req, res) => {
    try {
        const contrato = req.contratoIdVerificado; // Tomado del token verificado de forma segura

        const pool = await poolPromise;
        const request = pool.request();
        request.input('contrato', mssql.VarChar, contrato);

        const consulta = "SELECT * from dbo.Photos(@contrato)";
        let resultado = await request.query(consulta);
        return res.json({ success: true, data: resultado });

    } catch (err) {
        console.error('❌ Error en fotos-contrato:', err.message);
        return res.json({ success: false });
    }
});

// 2. OBTENER REPORTES DE TRÁFICO
app.post('/api/reportes/reportes-trafico', verificarToken24h, async (req, res) => {
    try {
        const contrato = req.contratoIdVerificado;

        const pool = await poolPromise;
        const request = pool.request();
        request.input('contrato', mssql.VarChar, contrato);

        const consulta = `
            SELECT r.IdReport, r.XTime, ta.TipoAccion, tr.TipoReporte, r.Ubicacion, r.Nota, r.XUser
            FROM LokReport as r
            INNER JOIN LokTipoAccion as ta ON ta.IdTipoAccion = r.FKLokTipoAccion
            INNER JOIN ICTipoReporte as tr ON tr.idTipoReporte = r.FKICTipoReporte
            WHERE r.FKLokContractID = @contrato
            ORDER BY r.XTime
        `;

        let resultado = await request.query(consulta);
        return res.json({ success: true, data: resultado.recordsets[0] });

    } catch (err) {
        console.error('❌ Error en reportes-trafico:', err.message);
        return res.json({ success: false });
    }
});

// 3. COMPARACIONES DE LOGÍSTICA VISUAL (API EXTERNA)
app.post('/api/reportes/visual-logistic', verificarToken24h, async (req, res) => {
    try {
        const contrato = req.contratoIdVerificado;
        const varEndpoint = `https://${Configuracion.URL_VISUALLOGISTIC}.azurewebsites.net/get-contract-comparisons/${contrato}`;

        try {
            const response = await axios.get(varEndpoint, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            return res.json({ success: true, info: response.data });
        } catch (e) {
            return res.json({ success: false, msg: "contrato no existe" });
        }

    } catch (err) {
        console.error('❌ Error en visual-logistic:', err.message);
        return res.json({ success: false });
    }
});

// 4. OBTENER INFORMACIÓN DE ESTADO DEL CONTRATO
app.post('/api/reportes/info-contrato', verificarToken24h, async (req, res) => {
    try {
        const contrato = req.contratoIdVerificado;

        const pool = await poolPromise;
        const request = pool.request();
        request.input('contrato', mssql.VarChar, contrato);

        let consulta = `
            SELECT FKLokDeviceId as Dispositivo,
                   InicioServicio AS ComienzoServicio,
                   CASE WHEN ISNULL(FechaHoraFin, DATEADD(hh,2,GETDATE())) >= '2016-05-01 00:00:00' THEN 'NO' ELSE 'SI' END AS backup_,
                   ISNULL(FechaHoraFin, DATEADD(hh,2,GETDATE())) AS FinalServicio,
                   LokContractId.Active as isActive,
                   FKLokTipoEquipo
            FROM LokContractID
            LEFT JOIN LokDeviceID ON FKLokDeviceID = DeviceID
            WHERE ContractID = @contrato
        `;

        let resultado = await request.query(consulta);
        return res.json({ success: true, data: resultado.recordsets[0] });

    } catch (err) {
        console.error('❌ Error en info-contrato:', err.message);
        return res.json({ success: false });
    }
});

// 5. GEOLOCALIZACIÓN DE FOTOS (DISPOSITIVOS VALITRONICS)
app.post('/api/reportes/device-valitronics', verificarToken24h, async (req, res) => {
    try {
        const contrato = req.contratoIdVerificado;

        const pool = await poolPromise;
        const request = pool.request();
        request.input('contrato', mssql.VarChar, contrato);

        const consulta = "SELECT Latitud, Longitud from dbo.Photos(@contrato) WHERE Latitud <> 0";
        let resultado = await request.query(consulta);
        return res.json({ success: true, data: resultado.recordsets[0] });

    } catch (err) {
        console.error('❌ Error en device-valitronics:', err.message);
        return res.json({ success: false });
    }
});

// =========================================================================
// 6. NUEVO ENDPOINT: OBTENER REPORTES DE DISPOSITIVOS POR STORED PROCEDURE
// =========================================================================
app.post('/api/reportes/reportes-device', verificarToken24h, async (req, res) => {
    try {
        // Obtenemos los datos decodificados desde el middleware de forma segura
        const decoded = req.tokenDecoded;

        // Validaciones preventivas por si el token de MailerSend no incluyó desfases horarios originalmente
        const diffHorario = req.diffhorario;
        const diffUTC = req.diffUTC;

        let m = moment();
        m.add(diffHorario, 'minutes');

        // Configuración de las variables para el SP
        let fechainicio = req.body.fechainicio;
        let fechafin = m.format('YYYY-MM-DD HH:mm:ss');
        let device = req.body.device;
        let utcMinutos = diffUTC;

        // Si mandan tipo == 0, sobreescribimos la fecha de fin por la que mande el cliente
        if (req.body.tipo == 0) {
            fechafin = req.body.fechafin;
        }

        // Selección dinámica del Store Procedure en base al tipo de equipo
        let procedure = "SelectJ701TrackMsgSimple";
        if (req.body.tipoequipo == 1) {
            procedure = "SelectWSLoksysMsg";
        } else if (req.body.tipoequipo == 2) {
            procedure = "SelectWLMsg";
        } else if (req.body.tipoequipo == 3) {
            procedure = "SelectEnvotechMsg";
        } else if (req.body.tipoequipo == 6) {
            procedure = "SelectCellTrackMsg";
        } else if (req.body.tipoequipo == 7) {
            procedure = "SelectNuevoMsg";
        } else if (req.body.tipoequipo == 10) {
            procedure = "SelectJT707TrackMsgSimple";
        }

        // Ejecución segura del SP usando parámetros tipados de mssql
        const pool = await poolPromise2;
        const request = pool.request();

        request.input('fechainicio', mssql.VarChar, fechainicio);
        request.input('fechafin', mssql.VarChar, fechafin);
        request.input('device', mssql.VarChar, device);
        request.input('utcMinutos', mssql.Int, utcMinutos);
        console.log('=== [DEBUG] Parámetros que se enviarán al SP ===');
        console.table({
            "Stored Procedure": procedure,
            "fechainicio": fechainicio,
            "fechafin": fechafin,
            "device": device,
            "utcMinutos": utcMinutos
        });
        console.log('================================================');
        // Disparamos el Stored Procedure mapeado dinámicamente
        let resultado = await request.execute(procedure);

        res.json({ success: true, data: resultado.recordsets[0] });

    } catch (err) {
        console.error('❌ Error en reportes-device:', err.message);
        res.json({ success: false });
    }
});

// =========================================================================
// 7. ENDPOINT: OBTENER INFORMACIÓN DETALLADA DE UN CONTRATO ÚNICO (Pool 1)
// =========================================================================
app.post('/api/reportes/contrato-unico', verificarToken24h, async (req, res) => {
    try {
        // Tomamos el contrato validado cruzadamente por el middleware
        const contrato = req.contratoIdVerificado;
        const decoded = req.tokenDecoded;

        // Validaciones preventivas por si el token viene del script de MailerSend sin estos campos
        const diffHorario = 0;

        // Conexión al Pool 1 (Base de datos de Contratos)
        const pool = await poolPromise;
        const request = pool.request();

        // Mapeamos los parámetros de forma segura
        request.input('contrato', mssql.VarChar, contrato);
        request.input('diffHorario', mssql.Int, req.DiferenciaHorariaM);

        // Tu consulta SQL estructurada de forma limpia con variables parametrizadas (@)
        const consulta = `
            SELECT
                c.ContractID,
                c.FKLokDeviceID,
                e.NombreEmpresa,
                c.PlacaTruck,
                CONVERT(varchar, DATEADD(MINUTE, 0, c.FechaHoraInicio), 20) AS fecha,
                CONCAT(c.LastMsgLat, ',', c.LastMsgLong) AS pos,
                ISNULL(c.FKTrayecto, 0) AS trayecto,
                r.DescripcionRuta,
                t.DescripcionTrayecto,
                c.ContainerNum,
                c.NombreConductor,
                c.Ref,
                tp.NombreTranspo,
                c.MovilConductor,
                c.PlacaTrailer,
                CONVERT(varchar, DATEADD(minute, 0, c.FechaHoraInicio), 20) AS fechainicio,
                ISNULL(
                    CONVERT(varchar, DATEADD(minute, 0, c.FechaHoraFin), 20),
                    CONVERT(varchar, DATEADD(minute, @diffHorario, GETDATE()), 20)
                ) AS fechafin,
                c.LastMsgLat,
                c.LastMsgLong,
                c.Active,
                d.Locked,
                ISNULL(t.DistanciaReal, 0) AS DistanciaCompleta,
                t.Origen,
                d.FKLokTipoEquipo,
                c.LastReportNota,
                c.LastReportUbica,
                c.LastReportTime,
                dbo.Tiempo3(
                    DATEDIFF(
                        MI,
                        CASE WHEN primer_cierre IS NULL THEN InicioServicio ELSE primer_cierre END,
                        CASE WHEN Active = 1 THEN DATEADD(HH, 2, GETDATE()) ELSE CASE WHEN ult_apertura IS NULL THEN FechaHoraFin ELSE ult_apertura END END
                    )
                ) AS TiempoServ
            FROM LokcontractID AS c
            INNER JOIN LokDeviceID AS d ON d.DeviceID = c.FKLokDeviceID
            LEFT JOIN ICEmpresa AS e ON e.IdEmpresa = c.FKICEmpresa
            LEFT JOIN ICRutas AS r ON r.IdRuta = c.FKICRutas
            LEFT JOIN Trayectos AS t ON c.FKTrayecto = t.IDTrayecto
            LEFT JOIN ICTransportadora AS tp ON tp.IdTransportadora = c.FKICTransportadora
            WHERE c.ContractID = @contrato
        `;

        let resultado = await request.query(consulta);

        return res.json({ success: true, data: resultado.recordsets[0] });

    } catch (err) {
        console.error('❌ Error en contrato-unico:', err.message);
        return res.json({ success: false });
    }
});

app.post('/api/reportes/enviar-contrato', async (req, res) => {
    try {
        const { contractId } = req.body;

        if (!contractId) {
            return res.status(400).json({
                success: false,
                message: 'Debe enviar el contractId'
            });
        }

        const resultado = await enviarReportePorContrato(contractId);

        if (!resultado.ok) {
            return res.status(400).json({
                success: false,
                message: resultado.mensaje || 'No fue posible enviar el reporte'
            });
        }

        return res.json({
            success: true,
            message: 'Reporte enviado correctamente'
        });

    } catch (err) {
        console.error('❌ Error en enviar-contrato:', err.message);

        return res.status(500).json({
            success: false,
            message: 'Error interno enviando el reporte'
        });
    }
});
// =========================================================================
// ENCENDER EL SERVIDOR
// =========================================================================
app.listen(PORT, () => {
    console.log(`🚀 Servidor de API corriendo en: http://localhost:${PORT}`);
});
