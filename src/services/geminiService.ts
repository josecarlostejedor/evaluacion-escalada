import { GoogleGenAI, ThinkingLevel } from "@google/genai";

// Lazy initialization to avoid issues during build or if the key is missing at startup.
let aiInstance: GoogleGenAI | null = null;

function getAI(): GoogleGenAI {
  if (!aiInstance) {
    // We try to get the key from multiple possible locations
    const apiKey = (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) || 
                   (import.meta.env?.VITE_GEMINI_API_KEY) || 
                   "";
    
    if (!apiKey) {
      console.warn("GEMINI_API_KEY is not defined. AI features will fail.");
    }
    aiInstance = new GoogleGenAI({ apiKey });
  }
  return aiInstance;
}

/**
 * Detecta puntos clave (cruces y esquinas) en la imagen binaria.
 * Implementa una versión simplificada de detección de esquinas para encontrar nodos del grafo.
 */
function detectKeypoints(data: Uint8ClampedArray, width: number, height: number): {x: number, y: number}[] {
  const points: {x: number, y: number}[] = [];
  const step = 10; // Sensibilidad de muestreo

  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const idx = (y * width + x) * 4;
      if (data[idx] > 127) {
        // Verificar si es un punto de interés (muchos vecinos blancos en área local)
        let neighbors = 0;
        for (let ky = -2; ky <= 2; ky++) {
          for (let kx = -2; kx <= 2; kx++) {
            if (data[((y + ky) * width + (x + kx)) * 4] > 127) neighbors++;
          }
        }
        // Un cruce suele tener una densidad específica de píxeles
        if (neighbors > 15 && neighbors < 22) {
          points.push({x, y});
        }
      }
    }
  }

  // Filtrar puntos redundantes (clústeres)
  const filtered: {x: number, y: number}[] = [];
  const minDist = 30;
  for (const p of points) {
    if (!filtered.some(f => Math.hypot(f.x - p.x, f.y - p.y) < minDist)) {
      filtered.push(p);
    }
  }
  return filtered;
}

/**
 * Analiza la estructura del nudo usando Keypoints y Grafos.
 */
async function analyzeGraphStructure(base64Str: string): Promise<{ processedBase64: string, graph: any }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const maxDim = 512;
      const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      
      // 1. Binarización agresiva para silueta
      for (let i = 0; i < data.length; i += 4) {
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        const val = gray > 140 ? 255 : 0;
        data[i] = data[i + 1] = data[i + 2] = val;
      }

      const keypoints = detectKeypoints(data, canvas.width, canvas.height);
      
      // 2. Construir Grafo (Conectividad)
      let edges = 0;
      const degrees = new Array(keypoints.length).fill(0);
      for (let i = 0; i < keypoints.length; i++) {
        for (let j = i + 1; j < keypoints.length; j++) {
          const dist = Math.hypot(keypoints[i].x - keypoints[j].x, keypoints[i].y - keypoints[j].y);
          if (dist < 100) { // Umbral de conexión
            edges++;
            degrees[i]++;
            degrees[j]++;
          }
        }
      }

      ctx.putImageData(imageData, 0, 0);
      
      resolve({
        processedBase64: canvas.toDataURL('image/jpeg', 0.8),
        graph: {
          nodes: keypoints.length,
          edges: edges,
          degree_distribution: degrees.sort((a, b) => b - a),
          average_connectivity: edges / (keypoints.length || 1)
        }
      });
    };
    img.src = base64Str;
  });
}

export async function validateImageAnswer(
  studentImageBase64: string,
  referenceImageUrl: string | undefined,
  questionText: string
): Promise<{ isCorrect: boolean; feedback: string }> {
  try {
    const studentAnalysis = await analyzeGraphStructure(studentImageBase64);
    
    let refAnalysis = null;
    if (referenceImageUrl) {
      try {
        const refResponse = await fetch(referenceImageUrl, { mode: 'cors' });
        if (refResponse.ok) {
          const refBlob = await refResponse.blob();
          const refBase64 = await blobToBase64(refBlob);
          refAnalysis = await analyzeGraphStructure(refBase64);
        }
      } catch (e) { console.warn(e); }
    }

    const prompt = `
Eres un experto en TOPOLOGÍA DE GRAFOS aplicado a nudos (DexKnot 2026).
He extraído el esqueleto matemático de los nudos.

DATOS DEL GRAFO:
${refAnalysis ? `REFERENCIA: Nodos=${refAnalysis.graph.nodes}, Aristas=${refAnalysis.graph.edges}, Conectividad=${refAnalysis.graph.average_connectivity.toFixed(2)}` : ""}
ALUMNO: Nodos=${studentAnalysis.graph.nodes}, Aristas=${studentAnalysis.graph.edges}, Conectividad=${studentAnalysis.graph.average_connectivity.toFixed(2)}

INSTRUCCIONES:
1. Compara la complejidad de los grafos. Si el número de nodos (cruces) y conexiones es similar, la estructura es correcta.
2. El nudo solicitado es: "${questionText}".
3. Usa la imagen binaria para confirmar que el flujo de la cuerda es el esperado.

Responde en JSON:
{
  "is_isomorphic": (true/false),
  "confianza_topologica": (0-1),
  "analisis": "breve explicación técnica",
  "feedback": "mensaje motivador para el alumno"
}
`;

    const parts: any[] = [
      { text: prompt },
      { text: "ESQUELETO DEL ALUMNO:" },
      { inlineData: { mimeType: "image/jpeg", data: studentAnalysis.processedBase64.split(',')[1] } }
    ];

    const ai = getAI();
    const response = await ai.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: [{ parts }],
      config: {
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
        temperature: 0.1
      }
    });

    const result = JSON.parse(response.text.replace(/```json\n?|```/g, "").trim());

    return { 
      isCorrect: result.is_isomorphic, 
      feedback: result.feedback 
    };

  } catch (error: any) {
    console.error(error);
    return { isCorrect: false, feedback: "Error en el análisis topológico. Intenta de nuevo." };
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  if (typeof window === 'undefined' || typeof FileReader === 'undefined') {
    return Promise.resolve("");
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

