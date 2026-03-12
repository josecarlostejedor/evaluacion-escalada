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
      { text: `Eres un experto mundial en topología de nudos y visión artificial avanzada. Tu misión es comparar la imagen del alumno con la imagen de referencia y determinar si representan el MISMO TIPO DE NUDO basándote EXCLUSIVAMENTE en la estructura topológica (recorrido y entrelazado).

      CONTEXTO DE LA TAREA: "${questionText}"

      ### REGLA DE ORO: IGNORAR ATRIBUTOS SUPERFICIALES ###
      - Ignora por completo: color de la cuerda, grosor, textura, material, fondo, iluminación, sombras, escala y ángulo de la foto.
      - NO digas cosas como "la cuerda es roja" o "el nudo es pequeño". Céntrate únicamente en la geometría del entrelazado.

      ### PROTOCOLO DE ANÁLISIS TOPOLÓGICO (PASO A PASO) ###

      PASO 1: DESCRIPCIÓN ESTRUCTURAL DE LA REFERENCIA
      - Identifica el número de cruces.
      - En cada cruce, indica qué segmento pasa por encima y cuál por debajo.
      - Identifica bucles y la dirección de entrada/salida de los cabos.

      PASO 2: DESCRIPCIÓN ESTRUCTURAL DEL ALUMNO (Analiza tanto la versión original como la rotada 180°)
      - Realiza el mismo análisis detallado: cruces (over/under), bucles y trayectoria de la cuerda.
      - Busca el "esqueleto" del nudo (la línea central del recorrido).

      PASO 3: VERIFICACIÓN TÉCNICA ESPECÍFICA (CASO RIZO/LLANO)
      - Si el nudo solicitado es un Rizo (Square Knot): Verifica que los dos extremos (chicote y firme) de cada lado salgan PARALELOS y por el MISMO LADO del bucle que los envuelve. Si salen cruzados, es un error estructural (nudo de vaca).

      PASO 4: COMPARACIÓN DE INVARIANTES
      - Compara las descripciones de los pasos 1 y 2.
      - El nudo es el mismo si la disposición de cruces y bucles es equivalente, incluso si está rotado o deformado elásticamente.

      ### FORMATO DE RESPUESTA (JSON ESTRICTO) ###
      {
        "analisis_referencia": "Descripción topológica del modelo.",
        "analisis_alumno": "Descripción topológica de la foto del alumno.",
        "checklist": {
          "num_cruces_coincide": boolean,
          "patron_over_under_coincide": boolean,
          "salidas_cabos_correctas": boolean
        },
        "isCorrect": boolean,
        "feedback": "Si es correcto: '¡Excelente! Has realizado el nudo correctamente.' Si es incorrecto: Explica el fallo estructural específico (ej: 'El cabo derecho pasa por encima cuando debería ir por debajo')."
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
            responseMimeType: "application/json",
            thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH }
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

