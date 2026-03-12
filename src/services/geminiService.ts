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
    const processedStudentImage = await preprocessImage(studentImageBase64);
    const studentInfo = getMimeTypeAndData(processedStudentImage);

    // Identificar el tipo de nudo por el texto de la pregunta
    const isRizo = questionText.toLowerCase().includes("rizo") || questionText.toLowerCase().includes("llano");
    const isOcho = questionText.toLowerCase().includes("ocho");

    const prompt = `
Analiza este nudo y genera un INFORME TÉCNICO DE ESTRUCTURA. 
Ignora color, fondo y grosor. Céntrate solo en el recorrido de la cuerda.

Responde ÚNICAMENTE en este formato JSON:
{
  "num_cruces": (número total de veces que la cuerda pasa sobre sí misma),
  "cabos_paralelos": (true/false, ¿los dos extremos de cada lado salen juntos y paralelos?),
  "forma_general": "descripción breve del recorrido",
  "fallo_detectado": "si ves algo estructuralmente raro, descríbelo"
}

Contexto: "${questionText}"
`;

    const parts: any[] = [
      { text: prompt },
      { text: "IMAGEN DEL ALUMNO A ANALIZAR:" },
      {
        inlineData: {
          mimeType: studentInfo.mimeType,
          data: studentInfo.data
        }
      }
    ];

    const ai = getAI();
    const response = await ai.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: [{ parts }],
      config: {
        responseMimeType: "application/json",
        temperature: 0.1 // Mínima creatividad, máxima precisión
      }
    });

    const text = response?.text;
    if (!text) throw new Error("Respuesta vacía");

    const cleanText = text.replace(/```json\n?|```/g, "").trim();
    const report = JSON.parse(cleanText);

    // --- LÓGICA DE DECISIÓN (EL CÓDIGO DECIDE, NO LA IA) ---
    
    if (isRizo) {
      // Un nudo de rizo correcto DEBE tener cabos paralelos. 
      // Si salen cruzados (nudo de vaca), cabos_paralelos será false.
      if (report.cabos_paralelos === true && report.num_cruces >= 2) {
        return {
          isCorrect: true,
          feedback: "¡Excelente! Has realizado el nudo de rizo correctamente. Los cabos salen paralelos como debe ser."
        };
      } else {
        return {
          isCorrect: false,
          feedback: report.cabos_paralelos === false 
            ? "El nudo parece un 'nudo de vaca'. Los cabos deben salir paralelos y por el mismo lado del bucle." 
            : "Revisa el entrelazado central, no parece un nudo de rizo correcto."
        };
      }
    }

    if (isOcho) {
      if (report.num_cruces >= 4) {
        return {
          isCorrect: true,
          feedback: "¡Muy bien! El nudo en forma de ocho tiene la estructura de cruces correcta."
        };
      } else {
        return {
          isCorrect: false,
          feedback: "Faltan cruces para que sea un nudo en ocho completo. Revisa el recorrido."
        };
      }
    }

    // Fallback para otros nudos: confiar en la evaluación general de la IA si no tenemos regla específica
    const looksCorrect = report.num_cruces > 0 && !report.fallo_detectado;
    return {
      isCorrect: looksCorrect,
      feedback: looksCorrect 
        ? "El nudo parece estar bien ejecutado." 
        : `Se ha detectado un posible error: ${report.fallo_detectado || "Estructura incompleta"}`
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

