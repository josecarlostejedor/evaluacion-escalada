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
 * Preprocesa la imagen para maximizar el contraste y el detalle de las sombras.
 * Mantiene la escala de grises para que la IA pueda percibir la profundidad (over/under).
 */
async function preprocessImage(base64Str: string, maxDimension: number = 1024): Promise<string> {
  if (typeof window === 'undefined' || typeof Image === 'undefined') {
    return base64Str;
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let width = img.width;
      let height = img.height;

      const scale = Math.min(maxDimension / width, maxDimension / height, 1);
      width *= scale;
      height *= scale;

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, width, height);
        
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
          // Grayscale con énfasis en contraste
          const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          
          // Aumentar contraste localmente para resaltar sombras de cruces
          let contrast = (gray - 128) * 1.2 + 128;
          contrast = Math.max(0, Math.min(255, contrast));

          data[i] = contrast;
          data[i + 1] = contrast;
          data[i + 2] = contrast;
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
    const processedStudentImage = await preprocessImage(studentImageBase64);
    const studentInfo = getMimeTypeAndData(processedStudentImage);

    let refInfo: { mimeType: string; data: string } | null = null;
    if (referenceImageUrl) {
      try {
        const refResponse = await fetch(referenceImageUrl, { mode: 'cors' });
        if (refResponse.ok) {
          const refBlob = await refResponse.blob();
          const refBase64 = await blobToBase64(refBlob);
          const processedRef = await preprocessImage(refBase64);
          refInfo = getMimeTypeAndData(processedRef);
        }
      } catch (e) {
        console.warn("No se pudo cargar la referencia, se validará por descripción técnica.");
      }
    }

    const prompt = `
Eres un experto mundial en TOPOLOGÍA y TEORÍA DE NUDOS.
Tu misión es realizar un análisis de profundidad y continuidad de la cuerda para validar su estructura.

Sigue este protocolo de pensamiento:
1. Identifica el nudo solicitado en el contexto.
2. Traza mentalmente el recorrido de la cuerda en la imagen de referencia (si existe).
3. Traza el recorrido en la imagen del alumno, identificando cada cruce y si la cuerda pasa POR ENCIMA o POR DEBAJO.
4. Compara ambos recorridos.

Responde ÚNICAMENTE en este formato JSON:
{
  "analisis_paso_a_paso": "Describe el recorrido detectado (ej: entra por arriba, cruza sobre X, entra en bucle Y...)",
  "estructura_correcta": (true/false),
  "num_cruces_detectados": (número),
  "fallo_especifico": "Si es incorrecto, describe exactamente qué cruce o dirección falla",
  "feedback_pedagogico": "Un mensaje motivador y claro para el alumno"
}

Contexto: "${questionText}"
`;

    const parts: any[] = [{ text: prompt }];

    if (refInfo) {
      parts.push({ text: "IMAGEN DE REFERENCIA (MODELO):" });
      parts.push({
        inlineData: { mimeType: refInfo.mimeType, data: refInfo.data }
      });
    }

    parts.push({ text: "IMAGEN DEL ALUMNO (A EVALUAR):" });
    parts.push({
      inlineData: { mimeType: studentInfo.mimeType, data: studentInfo.data }
    });

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

    const text = response?.text;
    if (!text) throw new Error("Respuesta vacía");

    const cleanText = text.replace(/```json\n?|```/g, "").trim();
    const result = JSON.parse(cleanText);

    return { 
      isCorrect: result.estructura_correcta === true, 
      feedback: result.feedback_pedagogico || result.fallo_especifico || "Revisa el nudo."
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

