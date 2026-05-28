require('dotenv').config();
const express = require('express');
const mssql = require('mssql');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3005;

// =========================================================================
// MIDDLEWARES (Configuraciones de la App)
// =========================================================================
app.use(cors()); // Permite que tu frontend consulte la API desde otro dominio
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

// =========================================================================
// ENDPOINT: CONSULTAR INFORMACIÓN DE UN CONTRATO DESDE EL TOKEN
// =========================================================================
app.post('/api/reportes/consultar-token', async (req, res) => {
    try {
        const { publicToken } = req.body;

        // 1. Validar que el token exista en la petición
        if (!publicToken) {
            return res.status(400).json({
                success: false,
                message: 'El token de acceso es requerido.'
            });
        }

        // 2. Verificar y decodificar el token criptográficamente
        let datosToken;
        try {
            datosToken = jwt.verify(publicToken, process.env.SEED_SECRET);
        } catch (jwtError) {
            // Si pasaron las 24 horas o el token fue alterado, entra aquí directamente
            return res.status(403).json({
                success: false,
                message: 'El enlace ha expirado (límite de 24 horas superado) o es inválido.'
            });
        }

        // Validar la estructura interna de nuestro token
        if (datosToken.tipo !== 'link_24h' || !datosToken.contractId) {
            return res.status(403).json({
                success: false,
                message: 'Estructura de token no autorizada.'
            });
        }

        const idContratoExtraido = datosToken.contractId;
        console.log(`🔓 Acceso autorizado para el contrato: ${idContratoExtraido}`);

        // 3. Esperar la conexión de la base de datos y realizar la consulta
        const pool = await poolPromise;
        const request = pool.request();

        // Evitamos inyección SQL mapeando el parámetro de forma segura
        request.input('contractId', mssql.VarChar, idContratoExtraido);

        // Consulta de telemetría (Ajusta los nombres de tus campos si varían)
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

        // 4. Responder con éxito al Frontend
        res.json({
            success: true,
            message: 'Acceso concedido exitosamente.',
            data: {
                contrato: datosContrato.ContractID,
                placa: datosContrato.PlacaTruck,
                conductor: datosContrato.NombreConductor,
                activo: datosContrato.Active
                // Aquí puedes mapear latitud, longitud, velocidad si tu tabla los maneja
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
// ENZENDER EL SERVIDOR
// =========================================================================
app.listen(PORT, () => {
    console.log(`🚀 Servidor de API corriendo en: http://localhost:${PORT}`);
});
