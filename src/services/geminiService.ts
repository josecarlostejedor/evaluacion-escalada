import { GoogleGenAI } from "@google/genai";

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
 * Resizes an image to a maximum dimension while maintaining aspect ratio.
 * This helps avoid "INVALID_ARGUMENT" errors from Gemini due to large image sizes.
 */
async function resizeImage(base64Str: string, maxDimension: number = 1024): Promise<string> {
  if (typeof window === 'undefined' || typeof Image === 'undefined') {
    return base64Str;
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let width = img.width;
      let height = img.height;

      if (width > height) {
        if (width > maxDimension) {
          height *= maxDimension / width;
          width = maxDimension;
        }
      } else {
        if (height > maxDimension) {
          width *= maxDimension / height;
          height = maxDimension;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.95)); // Increased quality for better rope detail
    };
    img.onerror = () => resolve(base64Str); // Fallback to original if error
    img.src = base64Str;
  });
}

function getMimeTypeAndData(base64Str: string): { mimeType: string; data: string } {
  const match = base64Str.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    return { mimeType: match[1], data: match[2] };
  }
  // Fallback if it's just the data part
  return { mimeType: "image/jpeg", data: base64Str };
}

/**
 * Rotates an image 180 degrees.
 */
async function rotateImage180(base64Str: string): Promise<string> {
  if (typeof window === 'undefined' || typeof Image === 'undefined') {
    return base64Str;
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.translate(img.width / 2, img.height / 2);
        ctx.rotate(Math.PI);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
      }
      resolve(canvas.toDataURL('image/jpeg', 0.95));
    };
    img.onerror = () => resolve(base64Str);
    img.src = base64Str;
  });
}

export async function validateImageAnswer(
  studentImageBase64: string,
  referenceImageUrl: string | undefined,
  questionText: string
): Promise<{ isCorrect: boolean; feedback: string }> {
  try {
    // Resize student image to avoid size limits
    const resizedStudentImage = await resizeImage(studentImageBase64);
    const rotatedStudentImage = await rotateImage180(resizedStudentImage);
    
    const studentInfo = getMimeTypeAndData(resizedStudentImage);
    const rotatedInfo = getMimeTypeAndData(rotatedStudentImage);

    // Fetch reference image and convert to base64
    let refInfo: { mimeType: string; data: string } | null = null;
    
    if (referenceImageUrl) {
      try {
        const refResponse = await fetch(referenceImageUrl, { mode: 'cors' });
        if (!refResponse.ok) throw new Error("Failed to fetch reference image");
        const refBlob = await refResponse.blob();
        const refBase64 = await blobToBase64(refBlob);
        // Also resize reference image just in case
        const resizedRef = await resizeImage(refBase64);
        refInfo = getMimeTypeAndData(resizedRef);
      } catch (e) {
        console.warn("Could not fetch reference image, validating without it:", e);
      }
    }

    const parts: any[] = [
      { text: `Eres un experto en análisis topológico de nudos y visión por computadora. Tu misión es validar si el nudo del alumno es estructuralmente idéntico al de referencia, ignorando estética y centrándote en la topología.

      PREGUNTA/TAREA: "${questionText}"

      ### ARQUITECTURA DE VERIFICACIÓN TOPOLÓGICA ###

      1. DETECCIÓN Y ESQUELETO:
         - Reduce mentalmente la cuerda a una línea central (esqueleto). Ignora grosor, color y material.
         - Aísla el nudo central del fondo.

      2. IDENTIFICACIÓN DE CRUCES Y GRAFO:
         - Identifica cada punto donde la cuerda se cruza consigo misma.
         - Determina qué segmento pasa sobre (over) y cuál bajo (under) en cada cruce.
         - Construye un grafo topológico: Nodos = cruces, Aristas = segmentos de cuerda.

      3. COMPARACIÓN MULTI-ORIENTACIÓN:
         - Analiza la imagen del alumno en su orientación original y en su rotación de 180° (proporcionadas abajo).
         - Considera rotaciones, espejos y deformaciones elásticas (el nudo sigue siendo el mismo si no se deshacen cruces).

      4. SISTEMA DE PUNTUACIÓN (0-100):
         - Número de cruces coincide: +30 pts
         - Patrón over/under coincide: +30 pts
         - Número de bucles coincide: +20 pts
         - Conectividad del grafo coincide: +20 pts

      ### REGLAS DE CLASIFICACIÓN ###
      - 90-100: CORRECTO (isCorrect: true)
      - 70-89: PROBABLEMENTE CORRECTO (isCorrect: true - sé flexible si la topología es clara)
      - <70: INCORRECTO (isCorrect: false)

      FORMATO DE RESPUESTA (JSON estricto):
      {
        "analisis_esqueleto": "Descripción del esqueleto detectado",
        "mapeo_cruces": "Lista de cruces detectados (ej: Cruce 1: superior sobre inferior)",
        "grafo_topologico": "Descripción de la conectividad del grafo",
        "puntuacion_similitud": number,
        "isCorrect": boolean,
        "feedback": "Si es correcto, felicita. Si es incorrecto, explica el fallo topológico específico basado en el recorrido de la cuerda."
      }` }
    ];

    if (refInfo) {
      parts.push({ text: "IMAGEN DE REFERENCIA (MODELO A SEGUIR):" });
      parts.push({
        inlineData: {
          mimeType: refInfo.mimeType,
          data: refInfo.data
        }
      });
    }

    parts.push({ text: "IMAGEN DEL ALUMNO (ORIENTACIÓN ORIGINAL):" });
    parts.push({
      inlineData: {
        mimeType: studentInfo.mimeType,
        data: studentInfo.data
      }
    });

    parts.push({ text: "IMAGEN DEL ALUMNO (ROTADA 180° PARA DOBLE VERIFICACIÓN):" });
    parts.push({
      inlineData: {
        mimeType: rotatedInfo.mimeType,
        data: rotatedInfo.data
      }
    });

    let response;
    let retries = 0;
    const maxRetries = 2;
    
    while (retries <= maxRetries) {
      try {
        const ai = getAI();
        response = await ai.models.generateContent({
          model: "gemini-3.1-pro-preview",
          contents: [{ parts }],
          config: {
            responseMimeType: "application/json"
          }
        });
        break;
      } catch (err: any) {
        const isQuotaError = err.message?.includes("429") || err.message?.includes("quota") || err.message?.includes("RESOURCE_EXHAUSTED");
        if (isQuotaError && retries < maxRetries) {
          retries++;
          await new Promise(resolve => setTimeout(resolve, 2000 * retries));
          continue;
        }
        throw err;
      }
    }

    const text = response?.text;
    if (!text) throw new Error("Empty response from AI");
    
    const result = JSON.parse(text);
    return {
      isCorrect: !!result.isCorrect,
      feedback: result.feedback || (result.isCorrect ? "Correcto" : "Incorrecto")
    };
  } catch (error: any) {
    console.error("Error validating image:", error);
    
    // Check for specific API errors
    const errorMsg = error.message || "";
    if (errorMsg.includes("429") || errorMsg.includes("quota") || errorMsg.includes("RESOURCE_EXHAUSTED")) {
      return { 
        isCorrect: false, 
        feedback: "El sistema está saturado. Por favor, espera 10 segundos y vuelve a intentarlo." 
      };
    }

    if (errorMsg.includes("INVALID_ARGUMENT") || errorMsg.includes("image")) {
      return { 
        isCorrect: false, 
        feedback: "Error técnico al procesar la imagen. Intenta tomar la foto de nuevo con menos brillo." 
      };
    }

    return { 
      isCorrect: false, 
      feedback: "No se pudo validar la imagen. Asegúrate de que sea clara y esté bien iluminada." 
    };
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

