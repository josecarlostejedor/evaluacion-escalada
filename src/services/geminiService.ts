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
 * Preprocesa la imagen para eliminar distractores y enfocarse en la estructura
 */
async function preprocessImage(base64Str: string, maxDimension: number = 800): Promise<string> {
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
      if (ctx) {
        ctx.drawImage(img, 0, 0, width, height);
        
        // Convertir a escala de grises para eliminar distracciones de color
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
          const gray = 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2];
          data[i] = gray;      // R
          data[i + 1] = gray;  // G
          data[i + 2] = gray;  // B
        }
        ctx.putImageData(imageData, 0, 0);
      }
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => resolve(base64Str);
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
    // Preprocesamiento: escala de grises y redimensionado
    const processedStudentImage = await preprocessImage(studentImageBase64);
    const studentInfo = getMimeTypeAndData(processedStudentImage);

    // Obtener imagen de referencia
    let refInfo: { mimeType: string; data: string } | null = null;
    
    if (referenceImageUrl) {
      try {
        const refResponse = await fetch(referenceImageUrl, { mode: 'cors' });
        if (!refResponse.ok) throw new Error("Failed to fetch reference image");
        const refBlob = await refResponse.blob();
        const refBase64 = await blobToBase64(refBlob);
        const processedRef = await preprocessImage(refBase64);
        refInfo = getMimeTypeAndData(processedRef);
      } catch (e) {
        console.warn("Could not fetch reference image, validating without it:", e);
      }
    }

    const prompt = `
Necesito que compares estos dos nudos y determines si son el MISMO tipo de nudo.

🎯 **INSTRUCCIONES IMPORTANTES:**
- Ignora COMPLETAMENTE el color de la cuerda, el fondo, la iluminación y el grosor.
- Concéntrate SOLO en cómo se cruza la cuerda consigo misma.
- Si el nudo está girado o visto desde otro ángulo, considera que puede ser el mismo.

🔍 **¿QUÉ DEBES ANALIZAR?**
1. ¿Cuántos cruces tiene el nudo? (puntos donde la cuerda se cruza)
2. En cada cruce: ¿qué parte pasa por encima y cuál por debajo?
3. ¿Cómo entran y salen los cabos de la cuerda?

📝 **RESPONDE EN ESTE FORMATO JSON:**
{
  "esCorrecto": true/false,
  "explicacion": "Explica brevemente si son iguales o diferentes, y por qué"
}

Contexto de la pregunta: "${questionText}"
`;

    const parts: any[] = [{ text: prompt }];

    if (refInfo) {
      parts.push({ text: "NUDO DE REFERENCIA (el correcto):" });
      parts.push({
        inlineData: {
          mimeType: refInfo.mimeType,
          data: refInfo.data
        }
      });
    }

    parts.push({ text: "NUDO DEL ALUMNO (a evaluar):" });
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
        const ai = getAI();
        response = await ai.models.generateContent({
          model: "gemini-3.1-pro-preview",
          contents: [{ parts }],
          config: {
            responseMimeType: "application/json",
            temperature: 0.1
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
      return {
        isCorrect: result.esCorrecto === true,
        feedback: result.explicacion || (result.esCorrecto ? "¡Correcto!" : "Incorrecto")
      };
    } catch (e) {
      console.error("JSON parse error:", e, "Raw text:", text);
      const isCorrect = text.toLowerCase().includes('"escorrecto": true') || text.toLowerCase().includes('"escorrecto":true');
      return {
        isCorrect,
        feedback: isCorrect ? "¡Excelente! Nudo validado correctamente." : "El nudo no parece correcto. Revisa el recorrido de la cuerda."
      };
    }
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

