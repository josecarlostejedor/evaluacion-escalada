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
      resolve(canvas.toDataURL('image/jpeg', 0.8)); // Use JPEG with 80% quality
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
      { text: `Eres un experto en escalada y cabuyería con años de experiencia docente. Tu tarea es evaluar con RIGOR TÉCNICO la imagen enviada por un alumno.
      
      OBJETIVO: Determinar si el alumno ha realizado correctamente el nudo o técnica solicitada, centrándote en la TOPOLOGÍA y el RECORRIDO de la cuerda.
      
      PREGUNTA/TAREA: "${questionText}"
      
      REGLAS CRÍTICAS DE EVALUACIÓN:
      1. TOPOLOGÍA Y ESTRUCTURA: Lo más importante es que el nudo tenga la estructura central correcta. Debes seguir visualmente el recorrido de la cuerda para verificar que entra, gira y sale por donde corresponde según el nudo solicitado.
      2. FLEXIBILIDAD DE MATERIALES: Sé totalmente flexible con el tipo de cuerda (color, grosor, material, estado de desgaste) y el fondo de la imagen. No busques una imagen idéntica a la de referencia, busca un nudo que FUNCIONE técnicamente.
      3. EJECUCIÓN: El nudo debe estar "peinado" (sin cruces innecesarios que debiliten la cuerda), pero prioriza que el recorrido sea el correcto. Si el nudo es el correcto y está bien hecho, es CORRECTO (isCorrect: true).
      4. COMPARACIÓN: ${refInfo ? "Usa la IMAGEN DE REFERENCIA solo como guía de la estructura técnica. El nudo del alumno debe compartir la misma lógica de entrelazado que el modelo." : "Identifica el nudo solicitado basándote en tus conocimientos expertos de cabuyería."}
      5. RIGOR: Solo marca como INCORRECTO si el nudo es de otro tipo, si el recorrido de la cuerda es erróneo (peligroso o no cumple la función del nudo) o si la imagen es tan borrosa que es imposible ver la estructura.
      6. PERSPECTIVA: Ten en cuenta que la foto puede estar tomada desde un ángulo diferente al de la referencia. Gira mentalmente el nudo para verificar su validez.

      FORMATO DE RESPUESTA (JSON estricto):
      {
        "isCorrect": boolean,
        "feedback": "Comentario técnico breve y motivador (máx 15 palabras). Si es incorrecto, explica qué parte del recorrido de la cuerda falla."
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

