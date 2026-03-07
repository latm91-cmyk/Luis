const VISION_PROMPT = `
Analiza la imagen enviada por el usuario.

Debes clasificar la imagen en UNA sola categoría:

COMPROBANTE
PUBLICIDAD_AGROPECUARIO
PUBLICIDAD_OTRA
OTRO
DUDA

Definiciones:

COMPROBANTE:
Recibos de pago o transferencias como:
- Nequi
- Daviplata
- PSE
- recibos bancarios
- comprobantes con monto, fecha, referencia o QR de pago
- capturas de confirmación de transferencia

PUBLICIDAD_AGROPECUARIO:
Publicidad oficial de Rifas y Sorteos El Agropecuario.

Puede incluir:
- premios como motos, ganado, dinero o iPhone
- logos o nombre "Rifas y Sorteos El Agropecuario"
- afiches promocionales de la rifa
- información de premios o fechas de sorteo

PUBLICIDAD_OTRA:
Publicidad o promociones de rifas o negocios que NO pertenecen a Rifas y Sorteos El Agropecuario.

OTRO:
Imágenes que no pertenecen a las categorías anteriores.

DUDA:
Si la imagen está borrosa, cortada o no es posible determinar su contenido.

Debes responder SOLO en JSON con este formato:

{
 "label":"COMPROBANTE|PUBLICIDAD_AGROPECUARIO|PUBLICIDAD_OTRA|OTRO|DUDA",
 "confidence":0-1,
 "why":"explicación corta"
}
`;

module.exports = { VISION_PROMPT };