const axios = require('axios');
const path = require('path');
// Cargamos las variables de entorno si no lo has hecho en tu archivo principal
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function enviarMensajePrueba() {
    // Tomamos los valores del .env o usamos los del curl por defecto si no existen
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    // Construimos la URL usando la versión v25.0 de tu curl
    const url = `https://graph.facebook.com/v25.0/${phoneId}/messages`;

    // Cuerpo del JSON idéntico a tu prueba
    const data = {
        messaging_product: "whatsapp",
        to: "573006624791",
        type: "template",
        template: {
            name: "3p_direct_integration_test_template",
            language: {
                code: "en_US"
            }
        }
    };

    // Configuración de cabeceras (Headers)
    const config = {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    };

    try {
        console.log('🚀 Enviando plantilla de prueba de WhatsApp...');
        const respuesta = await axios.post(url, data, config);

        console.log('✅ Mensaje enviado correctamente!');
        console.log('Respuesta de Meta:', respuesta.data);
        return respuesta.data;
    } catch (error) {
        console.error('💥 Error al enviar el mensaje de prueba:');
        if (error.response) {
            // El servidor respondió con un código de estado fuera del rango 2xx
            console.error('Detalle de Meta:', error.response.data);
        } else {
            // Ocurrió un problema al configurar la petición
            console.error('Mensaje de error:', error.message);
        }
        throw error;
    }
}

// Ejecutar la función de prueba de inmediato
enviarMensajePrueba();
