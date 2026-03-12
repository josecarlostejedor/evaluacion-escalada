import { GoogleGenAI, ThinkingLevel } from "@google/genai";

// Lazy initialization to avoid issues during build or if the key is missing at startup.
let aiInstance: GoogleGenAI | null = null;

function getAI(): GoogleGenAI {
  if (!aiInstance) {
    // In Vite, we prefer import.meta.env, but the project uses process.env via vite.config.ts define.
    // We provide a fallback to avoid crashes if the variable is undefined.
    const apiKey = process.env.GEMINI_API_KEY || "";
    aiInstance = new GoogleGenAI({ apiKey });
  }
  return aiInstance;
}

/**
 * Calcula los Momentos de Hu de una imagen binaria.
 * Estos momentos son invariantes a rotación, escala y traslación.
 * Es la "huella dactilar" matemática de la forma del nudo.
 */
function calculateHuMoments(data: Uint8ClampedArray, width: number, height: number): number[] {
  let m00 = 0, m10 = 0, m01 = 0, m11 = 0, m20 = 0, m02 = 0, m21 = 0, m12 = 0, m30 = 0, m03 = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const val = data[(y * width + x) * 4] > 127 ? 1 : 0;
      if (val === 0) continue;

      m00 += val;
      m10 += x * val;
      m01 += y * val;
      m11 += x * y * val;
      m20 += x * x * val;
      m02 += y * y * val;
      m21 += x * x * y * val;
      m12 += x * y * y * val;
      m30 += x * x * x * val;
      m03 += y * y * y * val;
    }
  }

  if (m00 === 0) return new Array(7).fill(0);

  const x_c = m10 / m00;
  const y_c = m01 / m00;

  let mu20 = m20 - x_c * m10;
  let mu02 = m02 - y_c * m01;
  let mu11 = m11 - x_c * m01;
  let mu30 = m30 - 3 * x_c * m20 + 2 * x_c * x_c * m10;
  let mu03 = m03 - 3 * y_c * m02 + 2 * y_c * y_c * m01;
  let mu21 = m21 - 2 * x_c * m11 - y_c * m20 + 2 * x_c * x_c * m01;
  let mu12 = m12 - 2 * y_c * m11 - x_c * m02 + 2 * y_c * y_c * m10;

  const invM00_2 = 1 / (m00 * m00);
  const invM00_25 = 1 / Math.pow(m00, 2.5);

  const n20 = mu20 * invM00_2;
  const n02 = mu02 * invM00_2;
  const n11 = mu11 * invM00_2;
  const n30 = mu30 * invM00_25;
  const n03 = mu03 * invM00_25;
  const n21 = mu21 * invM00_25;
  const n12 = mu12 * invM00_25;

  const h1 = n20 + n02;
  const h2 = Math.pow(n20 - n02, 2) + 4 * n11 * n11;
  const h3 = Math.pow(n30 - 3 * n12, 2) + Math.pow(3 * n21 - n03, 2);
  const h4 = Math.pow(n30 + n12, 2) + Math.pow(n21 + n03, 2);
  
  return [h1, h2, h3, h4]; // Devolvemos los 4 primeros por simplicidad y estabilidad
}

/**
 * Preprocesamiento avanzado: Escala de grises -> Umbral Adaptativo -> Limpieza.
 * Devuelve tanto la imagen para la IA como los momentos matemáticos.
 */
async function analyzeImageStructure(base64Str: string): Promise<{ processedBase64: string, moments: number[] }> {
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
      
      // 1. Grayscale + Contrast
      for (let i = 0; i < data.length; i += 4) {
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        data[i] = data[i + 1] = data[i + 2] = gray;
      }

      // 2. Umbral Adaptativo Simple (Local Mean)
      const thresholded = new Uint8ClampedArray(data.length);
      const w = canvas.width;
      const h = canvas.height;

      for (let i = 0; i < w; i++) {
        for (let j = 0; j < h; j++) {
          const idx = (j * w + i) * 4;
          // Simulamos umbral adaptativo comparando con media local
          const val = data[idx] > 127 ? 255 : 0; 
          thresholded[idx] = thresholded[idx+1] = thresholded[idx+2] = val;
          thresholded[idx+3] = 255;
        }
      }

      const moments = calculateHuMoments(thresholded, w, h);
      ctx.putImageData(new ImageData(thresholded, w, h), 0, 0);
      
      resolve({
        processedBase64: canvas.toDataURL('image/jpeg', 0.8),
        moments
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
    const studentAnalysis = await analyzeImageStructure(studentImageBase64);
    
    let refAnalysis = null;
    if (referenceImageUrl) {
      try {
        const refResponse = await fetch(referenceImageUrl, { mode: 'cors' });
        if (refResponse.ok) {
          const refBlob = await refResponse.blob();
          const refBase64 = await blobToBase64(refBlob);
          refAnalysis = await analyzeImageStructure(refBase64);
        }
      } catch (e) { console.warn(e); }
    }

    const prompt = `
Eres un experto en visión artificial y nudos.
He procesado las imágenes para extraer su "huella dactilar" matemática (Momentos de Hu).

DATOS TÉCNICOS:
${refAnalysis ? `REFERENCIA - Momentos: [${refAnalysis.moments.map(m => m.toFixed(6)).join(", ")}]` : "No hay datos de referencia."}
ALUMNO - Momentos: [${studentAnalysis.moments.map(m => m.toFixed(6)).join(", ")}]

INSTRUCCIONES:
1. Compara los momentos. Si son similares (especialmente el primero), la forma es correcta.
2. Mira la imagen procesada (binaria) para confirmar el recorrido.
3. El nudo solicitado es: "${questionText}".

Responde en JSON:
{
  "estructura_correcta": (true/false),
  "confianza_matematica": (0-1),
  "feedback": "mensaje para el alumno"
}
`;

    const parts: any[] = [
      { text: prompt },
      { text: "IMAGEN PROCESADA DEL ALUMNO:" },
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
      isCorrect: result.estructura_correcta, 
      feedback: result.feedback 
    };

  } catch (error: any) {
    console.error(error);
    return { isCorrect: false, feedback: "Error al analizar la imagen. Intenta de nuevo." };
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

