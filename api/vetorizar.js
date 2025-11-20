// api/vetorizar.js
import { GoogleGenerativeAI } from "@google/generative-ai";

export default async function handler(req, res) {
  // 1. Segurança: Aceitar apenas POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { imageBase64, width, height } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'Imagem não fornecida' });
    }

    // 2. Inicializar o Gemini com a chave do ambiente (ENV)
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    // Usamos o modelo Flash por ser mais rápido e barato para essa tarefa
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // 3. Preparar o prompt
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

    // 4. Chamar a IA
    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    let svgText = response.text();

    // 5. Limpeza básica do texto retornado
    svgText = svgText.replace(/```xml/g, '').replace(/```svg/g, '').replace(/```/g, '').trim();

    // 6. Responder ao Frontend
    return res.status(200).json({ svg: svgText });

  } catch (error) {
    console.error("Erro no servidor Vercel:", error);
    return res.status(500).json({ error: error.message });
  }
}