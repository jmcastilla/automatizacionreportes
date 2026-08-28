const axios = require("axios");

const token = "EAAOnqiiZC0yoBRi7KKnVZC5YUdJ5fSIZAlpLTZBQiFpRZClku65mVXceu7J70Iqt2vyqlQ1bcbUnaNlYUsjCa5jB7cQSARMfXVZAUeVICp6HAGJZA1ZCMQGFYYWT2VbrGSXGhYlR3Tn5FZBrTaZAwzPLxDf8vRue1tGi9CNR83cY2BxV2YHVNKrPIQsqI4AdHvHgZDZD";
const phoneNumberId = "1188880720969815";

function enviarReporteNovedades(
  telefono,
  placa,
  novedad,
  idReporte
) {
  return axios.post(
    `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to: telefono,
      type: "template",
      template: {
        name: "reportenovedades",
        language: {
          code: "es_CO"
        },
        components: [
          {
            type: "header",
            parameters: [
              {
                type: "text",
                text: placa
              }
            ]
          },
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: novedad
              }
            ]
          },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [
              {
                type: "text",
                text: idReporte
              }
            ]
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

enviarReporteNovedades(
  "573117475734",
  "ABC567",
  "Apertura",
  "987654"
)
.then(response => {
  console.log("ÉXITO:");
  console.log(JSON.stringify(response.data, null, 2));
})
.catch(error => {
  console.log("ERROR:");
  console.log(JSON.stringify(error.response?.data || error.message, null, 2));
});
