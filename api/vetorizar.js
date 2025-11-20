import { GoogleGenerativeAI } from "@google/generative-ai";

export default async function handler(req, res) {
  // Adiciona cabeçalhos CORS para permitir que seu site acesse a API
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', 'https://vetorizador.vercel.app/');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // Trata requisição OPTIONS (preflight do navegador)
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { imageBase64, width, height } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'Imagem não fornecida' });
    }

    // Inicializa o Gemini
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    
    // Define o modelo. O Gemini 1.5 Flash é o ideal.
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
      Você é um especialista em visão computacional.
      Analise esta imagem de satélite. O objetivo é criar uma máscara de segmentação binária para "Edificações".
      
      RETORNE APENAS CÓDIGO SVG VÁLIDO.
      Regras:
      1. O SVG deve ter viewBox="0 0 ${width} ${height}".
      2. O fundo deve ser preto (<rect width="100%" height="100%" fill="black"/>).
      3. Desenhe polígonos brancos (fill="white") exatamente sobre cada telhado.
      4. SEM texto markdown, SEM explicações. Apenas a string bruta do <svg>...</svg>.
    `;

    const imagePart = {
      inlineData: {
        data: imageBase64,
        mimeType: "image/png",
      },
    };

    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    let svgText = response.text();

    // Limpeza
    svgText = svgText.replace(/```xml/g, '').replace(/```svg/g, '').replace(/```/g, '').trim();

    return res.status(200).json({ svg: svgText });

  } catch (error) {
    console.error("Erro no servidor Vercel:", error);
    // Retorna o erro detalhado para ajudar no debug se falhar novamente
    return res.status(500).json({ error: error.message, details: error.toString() });
  }
}