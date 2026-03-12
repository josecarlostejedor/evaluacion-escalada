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
      { text: `Eres un experto mundial en topología de nudos y visión artificial avanzada. Tu misión es validar si el nudo en la imagen del alumno es ESTRUCTURALMENTE IDÉNTICO al nudo de referencia, basándote exclusivamente en el recorrido de la cuerda (topología).

      CONTEXTO: "${questionText}"

      ### PROTOCOLO "ANTIFALLOS" (ANÁLISIS PASO A PASO) ###
      1. Analiza esta imagen paso a paso antes de nombrar el nudo.
      2. Identifica el recorrido del cabo: observa detalladamente cómo entra y sale de cada cruce (quién pasa por arriba y quién por abajo).
      3. Identifica el recorrido del cabo: observa si los dos extremos (el chicote y el firme) de cada lado salen PARALELOS y por el MISMO LADO del bucle que los envuelve.
      4. Ignora si la silueta general parece una forma conocida (como un número o un ocho).
      5. Si los cabos salen juntos y paralelos, confírmame si es un nudo de rizo (llano).
      6. No te dejes engañar por la torsión de la cuerda, el material, el color o el ángulo de la foto.

      ### REGLAS DE ORO ###
      - Ignora por completo el color, grosor, textura de la cuerda, el fondo o la iluminación.
      - Céntrate únicamente en la geometría del entrelazado (patrón over/under).
      - El nudo es correcto si la disposición de cruces y bucles es equivalente a la referencia, permitiendo rotaciones y deformaciones elásticas.

      FORMATO DE RESPUESTA (JSON estricto):
      {
        "analisis_recorrido": "Descripción detallada del recorrido de la cuerda paso a paso.",
        "verificacion_tecnica": "Confirmación de salidas paralelas y estructura de bucles.",
        "isCorrect": boolean,
        "feedback": "Si es correcto: '¡Excelente! Has realizado el nudo correctamente, respetando la estructura técnica.' Si es incorrecto: Explica el fallo estructural específico basado en el recorrido de la cuerda."
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
          model: "gemini-3-flash-preview",
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
    
    // Clean potential markdown blocks and parse JSON
    const cleanText = text.replace(/```json\n?|```/g, "").trim();
    let result;
    try {
      result = JSON.parse(cleanText);
    } catch (e) {
      console.error("JSON parse error:", e, "Raw text:", text);
      // Fallback if JSON parsing fails but we have a clear indication of correctness
      const isCorrect = text.toLowerCase().includes('"iscorrect": true') || text.toLowerCase().includes('"iscorrect":true');
      return {
        isCorrect,
        feedback: isCorrect ? "¡Excelente! Nudo validado correctamente." : "El nudo no parece correcto. Revisa el recorrido de la cuerda."
      };
    }
    
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

