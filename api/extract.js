import Busboy from 'busboy';
import OpenAI from 'openai';

export const config = {
  api: {
    bodyParser: false,
  },
};

const systemPrompt = `
Je krijgt een gescande pagina. Zoek alle secties die starten met de grote titel "Delivery note".
Voor elke delivery note:
- Vind "Quantity" en "Unit" en pak de waarden uit de kolommen/rijen eronder.
- Datum: als aanwezig, geef DD-MM-YYYY (convert als nodig).
- Unit moet matchen ^[A-Z][0-9]{2}$. Bij twijfel: leeg laten en warning zetten.
- Aantal mag komma decimalen bevatten (12,5).
Output: een array delivery notes met datum, aantal (raw string), unit (letter+2 digits), optioneel confidence en warnings.
Als er geen delivery notes zijn: notes = [].
`;

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['notes'],
  properties: {
    notes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['datum', 'aantal', 'unit'],
        properties: {
          datum: { type: 'string' },
          aantal: { type: 'string' },
          unit: { type: 'string' },
          confidence: { type: 'number' },
          warnings: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });
  }

  try {
    const { imageBuffer, meta } = await parseMultipart(req);
    if (!imageBuffer) {
      return res.status(400).json({ error: 'Image is required' });
    }

    const openai = new OpenAI({ apiKey });
    const base64 = imageBuffer.toString('base64');
    const response = await openai.responses.create({
      model: 'gpt-4.1',
      input: [
        { role: 'system', content: systemPrompt.trim() },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extract delivery notes from this page and return strict JSON.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
          ],
        },
      ],
      output: {
        type: 'json_schema',
        json_schema: {
          name: 'delivery_notes',
          schema,
          strict: true,
        },
      },
    });

    const parsed = response.output?.[0]?.parsed || response.output_parsed || {};
    const notes = parsed.notes || [];
    return res.status(200).json({ notes, meta });
  } catch (err) {
    console.error(err);
    const message = err?.response?.data || err.message || 'Unknown error';
    return res.status(500).json({ error: message });
  }
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const chunks = [];
    let meta = {};

    busboy.on('file', (_fieldname, file) => {
      file.on('data', (data) => chunks.push(data));
    });
    busboy.on('field', (name, val) => {
      if (name === 'meta') {
        try {
          meta = JSON.parse(val);
        } catch {
          meta = {};
        }
      }
    });
    busboy.on('error', (err) => reject(err));
    busboy.on('finish', () => {
      const imageBuffer = chunks.length ? Buffer.concat(chunks) : null;
      resolve({ imageBuffer, meta });
    });
    req.pipe(busboy);
  });
}
