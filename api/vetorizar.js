import { GoogleGenerativeAI } from "@google/generative-ai";

export default async function handler(req, res) {
  // --- INÍCIO DA CORREÇÃO DE CORS ---
  const allowedOrigins = [
    'https://vetorizador.vercel.app',
    'http://localhost:3000',
    'http://127.0.0.1:5500' // Adicione outras portas se necessário
  ];
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    // Se a origem não estiver na lista (ex: requisições diretas), 
    // defina um valor padrão seguro ou omita o header (se preferir bloquear).
    // Usaremos o valor de produção como fallback.
    res.setHeader('Access-Control-Allow-Origin', 'https://vetorizador.vercel.app');
  }
  // --- FIM DA CORREÇÃO DE CORS ---

  // Adiciona outros cabeçalhos CORS (manter estes)
  res.setHeader('Access-Control-Allow-Credentials', true);
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

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      // Este erro ocorrerá se o Vercel não carregar a variável.
      return res.status(500).json({
        error: 'ERRO CRÍTICO: Chave GEMINI_API_KEY ausente',
        details: 'A variável de ambiente não foi carregada pelo servidor Vercel. Verifique as configurações de variáveis de ambiente na Vercel e o escopo (Production/Development).'
      });
    }

    // Inicializa o Gemini
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    // Define o modelo. O Gemini 1.5 Flash é o ideal.
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const prompt = `
      Você é um especialista em visão computacional e em análise de imagens aéreas de alta precisão.
      Sua tarefa é analisar rigorosamente a imagem de satélite fornecida e criar uma **máscara de segmentação binária exclusiva** para **Edificações, Telhados e trapiches**. Perceba que a imagem pode conter outros elementos como vegetação, estradas, água, sombras, etc., mas você deve focar apenas nas estruturas construídas pelo homem.
      
      RETORNE APENAS CÓDIGO SVG VÁLIDO E NADA MAIS.

      Regras estritas para o SVG:
      1. O SVG deve ter viewBox="0 0 ${width} ${height}" e NENHUM outro atributo (como 'width' ou 'height').
      2. O fundo deve ser preto: **<rect width="100%" height="100%" fill="black"/>**.
      3. Desenhe polígonos brancos: use **<polygon fill="white" points="..."/>** (preferencialmente) ou **<path fill="white" d="..."/>** para cobrir exatamente o footprint de cada telhado/edificação/benfeitoria detectada.
      4. A geometria deve ser o mais precisa possível.
      5. SEM texto, SEM explicação, SEM markdown, SEM comentários, SEM tag de XML declaration (<?xml...?>).
      6. Comece com <svg> e termine com </svg>.
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

    // 1. Limpeza para remover cabeçalhos de markdown, XML e caracteres invisíveis
    svgText = svgText
      .replace(/```xml/g, '')
      .replace(/```svg/g, '')
      .replace(/```/g, '')
      .replace(/<\?xml.*\?>/g, '')  
      .replace(/[\x00-\x1F\x7F]/g, '') 
      .trim(); 

    // 2. Limpeza para remover texto ou comentários antes do <svg>
    const svgStartIndex = svgText.indexOf('<svg');
    if (svgStartIndex !== -1) {
      svgText = svgText.substring(svgStartIndex);
    }

    // 3. Limpeza para remover texto ou comentários após o </svg>
    const svgEndIndex = svgText.lastIndexOf('</svg>');
    if (svgEndIndex !== -1) {
      svgText = svgText.substring(0, svgEndIndex + 6);
    }

    // O replace garante que, mesmo se o Gemini retornar o xmlns, ele não o duplique
    svgText = svgText.replace(
      /<svg\s+viewBox/, 
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox'
    );

    if (!svgText.startsWith('<svg') || !svgText.endsWith('</svg>')) {
        throw new Error("O modelo não retornou um SVG limpo.");
    }

    return res.status(200).json({ svg: svgText });

  } catch (error) {
    console.error("Erro no servidor Vercel:", error);
    // Retorna o erro detalhado para ajudar no debug se falhar novamente
    return res.status(500).json({ error: error.message, details: error.toString() });
  }
}