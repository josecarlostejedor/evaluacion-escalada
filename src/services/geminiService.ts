import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

/**
 * Resizes an image to a maximum dimension while maintaining aspect ratio.
 * This helps avoid "INVALID_ARGUMENT" errors from Gemini due to large image sizes.
 */
async function resizeImage(base64Str: string, maxDimension: number = 1024): Promise<string> {
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

export async function validateImageAnswer(
  studentImageBase64: string,
  referenceImageUrl: string | undefined,
  questionText: string
): Promise<{ isCorrect: boolean; feedback: string }> {
  try {
    // Resize student image to avoid size limits
    const resizedStudentImage = await resizeImage(studentImageBase64);
    const studentInfo = getMimeTypeAndData(resizedStudentImage);

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
      { text: `Eres un experto mundial en seguridad de montaña y cabuyería. Tu única misión es validar la INTEGRIDAD TÉCNICA de un nudo basándote EXCLUSIVAMENTE en su TOPOLOGÍA (el camino que sigue la cuerda).

      PREGUNTA/TAREA: "${questionText}"

      PROTOCOLO DE ANÁLISIS TOPOLÓGICO (OBLIGATORIO):
      1. ABSTRACCIÓN TOTAL: Ignora el color, grosor, material, desgaste de la cuerda, fondo e iluminación. Trata la cuerda como un diagrama de flujo de líneas.
      2. MAPEO DE INTERSECCIONES: Analiza la parte central del nudo. Identifica cada punto donde la cuerda se cruza. Verifica si la cuerda pasa por ENCIMA o por DEBAJO exactamente como dicta la técnica del nudo solicitado.
      3. COMPARACIÓN DE RECORRIDO: Compara el recorrido (el "esqueleto") del nudo del alumno con la imagen de referencia. El nudo es CORRECTO si el patrón de entrelazado es funcionalmente idéntico, sin importar el ángulo de la foto o el tipo de cuerda.
      4. REGLA DE ORO: Si el nudo es funcional y sigue el camino correcto, ES CORRECTO (isCorrect: true). No penalices nudos "feos", poco apretados o visualmente distintos a la referencia si la topología es la adecuada.
      5. RIGOR TÉCNICO: Solo marca como INCORRECTO si el recorrido es erróneo (peligroso) o si el nudo es de un tipo diferente al solicitado.

      FORMATO DE RESPUESTA (JSON estricto):
      {
        "analisis_topologico": "Describe el camino de la cuerda y los cruces clave observados",
        "isCorrect": boolean,
        "feedback": "Si es correcto, felicita brevemente. Si es incorrecto, indica exactamente qué cruce de cuerda está mal (ej: 'la cuerda debería pasar por debajo del bucle central')."
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

    parts.push({ text: "IMAGEN DEL ALUMNO (A EVALUAR):" });
    parts.push({
      inlineData: {
        mimeType: studentInfo.mimeType,
        data: studentInfo.data
      }
    });

    let response;
    let retries = 0;
    const maxRetries = 2;
    
    while (retries <= maxRetries) {
      try {
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
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

