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
      { text: `Actúa como un experto mundial en teoría de nudos, seguridad en montaña y visión por computadora. Tu tarea es validar la INTEGRIDAD TÉCNICA de un nudo basándote EXCLUSIVAMENTE en su TOPOLOGÍA (el camino físico de la cuerda).

      PREGUNTA/TAREA: "${questionText}"

      ### PROTOCOLO DE ANÁLISIS ESTRUCTURAL (OBLIGATORIO) ###

      PASO 1: ANÁLISIS DE LA REFERENCIA (IMAGEN A)
      - Describe la trayectoria de la cuerda siguiendo los cruces (ej. "Entra por arriba, cruza por debajo de la línea central, forma un bucle...").
      - Identifica la secuencia de cruces (over/under) y el número de bucles.

      PASO 2: ANÁLISIS DEL ALUMNO (IMAGEN B)
      - Describe la trayectoria en la imagen del alumno bajo el mismo criterio técnico.
      - Ignora sistemáticamente: Color, textura, grosor del material, fondo, iluminación y ángulo de cámara. Trata la cuerda como un diagrama de líneas.

      PASO 3: COMPARACIÓN TOPOLÓGICA
      - Determina si las dos estructuras son isomorfas (idénticas en forma técnica).
      - ¿Es posible transformar el nudo del alumno en el de referencia simplemente tensando la cuerda sin deshacer ningún cruce?

      PASO 4: VEREDICTO
      - Si la topología coincide, el nudo es CORRECTO (isCorrect: true), incluso si visualmente es distinto o está "mal peinado".
      - Solo marca como INCORRECTO si el recorrido es erróneo, peligroso o es un nudo diferente.

      FORMATO DE RESPUESTA (JSON estricto):
      {
        "paso1_analisis_referencia": "Descripción técnica de la trayectoria en la referencia",
        "paso2_analisis_alumno": "Descripción técnica de la trayectoria en la foto del alumno",
        "paso3_comparacion": "Explicación de por qué coinciden o no topológicamente",
        "isCorrect": boolean,
        "feedback": "Mensaje motivador. Si es incorrecto, indica exactamente en qué punto del recorrido falla la cuerda (ej: 'el chicote debería pasar por debajo del bucle central')."
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

