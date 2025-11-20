import init, { vetorizar_imagem } from '/vetoriza/pkg/vetoriza.js';

// --- CONFIGURAÇÃO INICIAL ---
const loader = document.getElementById('loader-overlay');
const loaderText = document.getElementById('loader-text');
let debugMaskLayer = null;
const geojsonFeatures = [];

// Inicializa o WASM (Vetorizador)
try {
  await init();
  console.log("Módulo WASM carregado com sucesso.");
} catch (e) {
  console.error("Falha ao carregar WASM:", e);
  alert("Erro crítico: O módulo de vetorização não carregou.");
}

// --- MAPA ---
const map = L.map('map').setView([-25.567859, -49.359602], 16);

const satelliteMap = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: 'Tiles &copy; Esri',
  maxZoom: 21,
  maxNativeZoom: 19,
  preferCanvas: true
});
satelliteMap.addTo(map);

const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

const drawControl = new L.Control.Draw({
  edit: { featureGroup: drawnItems },
  draw: { polygon: true, marker: false, polyline: false, circle: false, rectangle: false }
});
map.addControl(drawControl);

// --- EVENTOS DO MAPA ---
map.on(L.Draw.Event.CREATED, (e) => {
  if (e.layerType === 'polygon') {
    drawnItems.clearLayers();
    geojsonFeatures.length = 0; // Limpa features anteriores
    
    if (debugMaskLayer) {
      map.removeLayer(debugMaskLayer);
      debugMaskLayer = null;
    }

    const layer = e.layer;
    const bounds = layer.getBounds();
    layer.remove(); // Remove o desenho manual para não atrapalhar a captura

    // Pequeno delay para garantir que a UI atualizou
    setTimeout(() => processarAreaDesenhada(bounds), 500);
  }
});

// --- FUNÇÃO DE COMUNICAÇÃO COM A API ---
async function chamarBackendGemini(base64Image, width, height) {
  // URL relativa: funciona no localhost:3000 e no vercel.app
  const url = '/api/vetorizar'; 

  console.log("Enviando imagem para processamento no servidor...");

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: base64Image,
        width: width,
        height: height
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Erro do servidor (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    
    if (!data.svg) {
      throw new Error("O servidor não retornou um SVG válido.");
    }

    return data.svg;

  } catch (error) {
    console.error("Erro na comunicação com a API:", error);
    throw error;
  }
}

// --- LÓGICA PRINCIPAL ---
async function processarAreaDesenhada(bounds) {
  loaderText.textContent = 'Capturando imagem da área...';
  loader.style.display = 'flex';

  leafletImage(map, async (err, mainCanvas) => {
    if (err) {
      loader.style.display = 'none';
      alert("Erro ao capturar mapa: " + err.message);
      return;
    }

    const width = mainCanvas.width;
    const height = mainCanvas.height;
    
    // Pega apenas os dados base64 (remove o prefixo data:image/png;base64,)
    const base64Full = mainCanvas.toDataURL('image/png').split(',')[1];

    loaderText.textContent = 'Analisando com IA (Aguarde)...';
    await yieldToMain();

    try {
      // 1. Chama a API Vercel (Serverless)
      const svgString = await chamarBackendGemini(base64Full, width, height);
      console.log("SVG recebido da IA.");

      console.log("Conteúdo do SVG (Debug):", svgString);

      // 2. Renderiza o SVG em uma imagem para extrair pixels
      const maskImage = new Image();
      const svgBlob = new Blob([svgString], {type: 'image/svg+xml;charset=utf-8'});
      const url = URL.createObjectURL(svgBlob);

      maskImage.onload = async () => {
        // 3. Desenha a máscara em um canvas invisível
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = width;
        maskCanvas.height = height;
        const maskCtx = maskCanvas.getContext('2d');
        maskCtx.drawImage(maskImage, 0, 0);
        
        URL.revokeObjectURL(url);

        // DEBUG: Mostra a máscara no mapa (opcional)
        
        if (debugMaskLayer) map.removeLayer(debugMaskLayer);
        debugMaskLayer = L.imageOverlay(maskCanvas.toDataURL(), bounds, { opacity: 0.5 });
        debugMaskLayer.addTo(map);
        

        // 4. Limpeza de ruído (Morfologia)
        applyMorphologicalClean(maskCtx, width, height);

        loaderText.textContent = 'Vetorizando polígonos...';
        await yieldToMain();

        // 5. Prepara para o WASM
        const base64Mask = maskCanvas.toDataURL('image/png').split(',')[1];
        
        try {
           // Chama o Rust/WASM para transformar pixels em GeoJSON
           const geojsonStr = vetorizar_imagem(base64Mask);
           const geojsonResult = JSON.parse(geojsonStr);
           
           // Converte coordenadas de pixel (0,0) para Lat/Lng reais
           const geojsonConvertido = converterPixelsParaLatLng(geojsonResult, maskCanvas, bounds);
           
           if (geojsonConvertido.features.length === 0) {
             alert("A IA não detectou construções nesta área.");
           } else {
             const poligonosVetorizados = L.geoJSON(geojsonConvertido, { 
               style: { color: '#00ffcc', weight: 2, fillOpacity: 0.3 } 
             });
             drawnItems.addLayer(poligonosVetorizados);
             // Guarda para exportação
             geojsonFeatures.push(...geojsonConvertido.features);
           }

        } catch (e) {
           console.error("Erro no processo de vetorização (WASM/Turf):", e);
           alert("Erro ao processar vetores.");
        }
        
        loader.style.display = 'none';
      };

      maskImage.onerror = () => {
        throw new Error("Falha ao renderizar o SVG retornado pela IA.");
      };

      maskImage.src = url;

    } catch (error) {
      console.error("Erro Fatal:", error);
      alert("Erro: " + error.message);
      loader.style.display = 'none';
    }

  }, { scale: 1, tileLayer: satelliteMap, mapBounds: bounds });
}

// --- UTILITÁRIOS ---

function yieldToMain() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function applyMorphologicalOperation(ctx, width, height, operationType, kernelSize = 5) {
  if (kernelSize % 2 === 0) kernelSize += 1;
  const originalData = ctx.getImageData(0, 0, width, height);
  const processedData = new ImageData(width, height);
  const k_offset = Math.floor(kernelSize / 2);
  const isDilate = operationType === 'dilate';
  const comparison = isDilate ? (a, b) => a > b : (a, b) => a < b;
  const initialValue = isDilate ? 0 : 255;

  // Simples implementação de morfologia binária
  const data = originalData.data;
  const outData = processedData.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let bestVal = initialValue;
      // Otimização: verificar apenas o canal vermelho já que é p&b
      for (let ky = -k_offset; ky <= k_offset; ky++) {
        for (let kx = -k_offset; kx <= k_offset; kx++) {
          const px = x + kx;
          const py = y + ky;
          if (px >= 0 && px < width && py >= 0 && py < height) {
            const idx = (py * width + px) * 4;
            if (comparison(data[idx], bestVal)) {
              bestVal = data[idx];
            }
          }
        }
      }
      const outIndex = (y * width + x) * 4;
      outData[outIndex] = bestVal;     // R
      outData[outIndex + 1] = bestVal; // G
      outData[outIndex + 2] = bestVal; // B
      outData[outIndex + 3] = 255;     // Alpha
    }
  }
  ctx.putImageData(processedData, 0, 0);
}

function applyMorphologicalClean(ctx, width, height) {
  // Ajuste fino para remover ruídos e fechar telhados
  applyMorphologicalOperation(ctx, width, height, 'dilate', 5); // Fecha buracos
  applyMorphologicalOperation(ctx, width, height, 'erode', 5);  // Restaura borda
}

function converterPixelsParaLatLng(geojson, canvas, mapBounds) {
  const imgWidth = canvas.width;
  const imgHeight = canvas.height;
  const featuresFinais = [];

  const MIN_AREA_METERS = 5.0; // Área mínima para considerar um edifício
  const TOLERANCIA_SIMPLIFICACAO = 0.000005;

  if (!geojson || !geojson.features) return turf.featureCollection([]);

  geojson.features.forEach(feature => {
    // Garante que é polígono
    if (!feature.geometry || feature.geometry.type !== 'Polygon') return;
    
    const coords = feature.geometry.coordinates[0];
    if (!coords || coords.length < 3) return;

    // Conversão Matemática: Pixel -> Lat/Lng
    const newCoords = coords.map(p => {
      // p[0] é X, p[1] é Y (de cima para baixo)
      const lng = mapBounds.getWest() + ((p[0] / imgWidth) * (mapBounds.getEast() - mapBounds.getWest()));
      const lat = mapBounds.getNorth() - ((p[1] / imgHeight) * (mapBounds.getNorth() - mapBounds.getSouth()));
      return [lng, lat];
    });

    // Fecha o anel se necessário
    if (newCoords[0][0] !== newCoords[newCoords.length - 1][0]) {
      newCoords.push([...newCoords[0]]);
    }

    try {
      const poly = turf.polygon([newCoords]);
      // Simplifica para ficar com cara de "Building Footprint" (menos vértices)
      const simplified = turf.simplify(poly, { tolerance: TOLERANCIA_SIMPLIFICACAO, highQuality: true });
      
      // AQUI é onde o filtro é aplicado.
      if (turf.area(simplified) > MIN_AREA_METERS) { // Agora verifica se é maior que 5.0 m²
        simplified.properties = { 
          id: `imovel_${geojsonFeatures.length + featuresFinais.length + 1}`,
          area_m2: turf.area(simplified).toFixed(2)
        };
        featuresFinais.push(simplified);
      }
    } catch (e) {
      // Ignora polígonos inválidos gerados pelo trace
    }
  });

  return turf.featureCollection(featuresFinais);
}


// --- EXPORTAÇÃO ---
async function exportarShapefile() {
  if (geojsonFeatures.length === 0) { 
    alert("Não há polígonos para exportar. Desenhe uma área e aguarde o processamento."); 
    return; 
  }
  
  const geojson = { type: "FeatureCollection", features: geojsonFeatures };
  const options = { folder: 'mapeamento_ia', types: { polygon: 'edificacoes' } };
  
  loaderText.textContent = 'Gerando Shapefile...';
  loader.style.display = 'flex';

  try {
    // @ts-ignore (shpwrite é global)
    const zipData = await window.shpwrite.zip(geojson, options);
    const zipBlob = new Blob([zipData], { type: 'application/zip' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(zipBlob);
    link.download = 'mapeamento_edificacoes.zip';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (e) { 
    console.error("Erro ao exportar:", e);
    alert("Erro ao gerar arquivo ZIP.");
  } finally {
    loader.style.display = 'none';
  }
}

// Expõe para o botão do HTML
window.exportarShapefile = exportarShapefile;