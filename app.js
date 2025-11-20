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
// Centro do mapa mantido
const MAP_CENTER = [-25.706923, -52.385530]; 
const map = L.map('map').setView(MAP_CENTER, 15);

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
  draw: { 
    polygon: {
      shapeOptions: {
        color: '#007bff', 
        fillOpacity: 0.1
      }
    }, 
    marker: false, polyline: false, circle: false, rectangle: false }
});
map.addControl(drawControl);

// --- EVENTOS DO MAPA ---
map.on(L.Draw.Event.CREATED, (e) => {
  if (e.layerType === 'polygon') {
    geojsonFeatures.length = 0; 
    
    if (debugMaskLayer) {
      map.removeLayer(debugMaskLayer);
      debugMaskLayer = null;
    }

    const layer = e.layer;
    const bounds = layer.getBounds();
    drawnItems.addLayer(layer); 
    
    // O polígono de seleção manual só é removido após o processamento bem-sucedido
    setTimeout(() => processarAreaDesenhada(bounds), 500);
  }
});

// --- FUNÇÃO DE COMUNICAÇÃO COM A API (REAL) ---
async function chamarBackendGemini(base64Image, width, height) {
  // URL relativa: funciona no localhost:3000 e no vercel.app
  const url = '/api/vetorizar'; 

  console.log("Enviando imagem para processamento no servidor...");

  try {
    // 1. CHAMA O ENDPOINT REAL DO VERCEL
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: base64Image,
        width: width, // Envia as dimensões capturadas
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
      drawnItems.clearLayers(); 
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
      // O SVG retornado terá o viewBox ajustado (graças ao vetorizar.js)
      const svgBlob = new Blob([svgString], {type: 'image/svg+xml;charset=utf-8'});
      const url = URL.createObjectURL(svgBlob);

      maskImage.onload = async () => {
        // 3. Desenha a máscara em um canvas invisível
        const maskCanvas = document.createElement('canvas');
        
        // CORREÇÃO ESSENCIAL: O Canvas de processamento DEVE ter as dimensões exatas 
        // da imagem capturada para que as coordenadas do SVG e a conversão Lat/Lng 
        // funcionem corretamente.
        maskCanvas.width = width; 
        maskCanvas.height = height;
        
        const maskCtx = maskCanvas.getContext('2d');
        maskCtx.drawImage(maskImage, 0, 0, width, height);
        
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
           
           // Converte coordenadas de pixel para Lat/Lng reais
           const geojsonConvertido = converterPixelsParaLatLng(geojsonResult, maskCanvas, bounds);
           
           if (geojsonConvertido.features.length === 0) {
             alert("A IA não detectou construções nesta área.");
             drawnItems.clearLayers(); 
           } else {
             const poligonosVetorizados = L.geoJSON(geojsonConvertido, { 
               style: { color: '#00ffcc', weight: 2, fillOpacity: 0.3 } 
             });
             // Remove o polígono de seleção manual e adiciona os vetores
             drawnItems.clearLayers(); 
             drawnItems.addLayer(poligonosVetorizados);
             // Guarda para exportação
             geojsonFeatures.push(...geojsonConvertido.features);
           }

        } catch (e) {
           console.error("Erro no processo de vetorização (WASM/Turf):", e);
           alert("Erro ao processar vetores.");
           drawnItems.clearLayers(); 
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
      drawnItems.clearLayers(); 
    }

  }, { scale: 1, tileLayer: satelliteMap, mapBounds: bounds });
}

// --- UTILITÁRIOS (Sem Alterações) ---

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

  const data = originalData.data;
  const outData = processedData.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let bestVal = initialValue;
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
      outData[outIndex] = bestVal;     
      outData[outIndex + 1] = bestVal; 
      outData[outIndex + 2] = bestVal; 
      outData[outIndex + 3] = 255;     
    }
  }
  ctx.putImageData(processedData, 0, 0);
}

function applyMorphologicalClean(ctx, width, height) {
  applyMorphologicalOperation(ctx, width, height, 'dilate', 5); 
  applyMorphologicalOperation(ctx, width, height, 'erode', 5);  
}

function converterPixelsParaLatLng(geojson, canvas, mapBounds) {
  const imgWidth = canvas.width;
  const imgHeight = canvas.height;
  const featuresFinais = [];

  const MIN_AREA_METERS = 5.0; 
  const TOLERANCIA_SIMPLIFICACAO = 0.000005;

  if (!geojson || !geojson.features) return turf.featureCollection([]);

  geojson.features.forEach(feature => {
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
      const simplified = turf.simplify(poly, { tolerance: TOLERANCIA_SIMPLIFICACAO, highQuality: true });
      
      if (turf.area(simplified) > MIN_AREA_METERS) {
        simplified.properties = { 
          id: `imovel_${geojsonFeatures.length + featuresFinais.length + 1}`,
          area_m2: turf.area(simplified).toFixed(2)
        };
        featuresFinais.push(simplified);
      }
    } catch (e) {
      // Ignora polígonos inválidos
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
    alert(`Exportação concluída! Foram exportados ${geojsonFeatures.length} polígonos.`);
  } catch (e) { 
    console.error("Erro ao exportar:", e);
    alert("Erro ao gerar arquivo ZIP.");
  } finally {
    loader.style.display = 'none';
  }
}

// Expõe para o botão do HTML
window.exportarShapefile = exportarShapefile;