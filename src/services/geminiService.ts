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
Eres un analizador técnico de nudos. Tu misión es extraer la ESTRUCTURA de los nudos presentados.
IGNORA: Color, grosor, fondo, iluminación y sombras.
CÉNTRATE EN: Cruces (quién pisa a quién), bucles y dirección de los cabos.

Responde ÚNICAMENTE en este formato JSON:
{
  "referencia": {
    "num_cruces": (número),
    "num_bucles": (número),
    "cabos_paralelos": (true/false),
    "tipo": "nombre del nudo"
  },
  "alumno": {
    "num_cruces": (número),
    "num_bucles": (número),
    "cabos_paralelos": (true/false),
    "tipo": "nombre detectado"
  },
  "analisis_diferencial": "explicación de diferencias estructurales si las hay"
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
        temperature: 0.1
      }
    });

    const text = response?.text;
    if (!text) throw new Error("Respuesta vacía");

    const cleanText = text.replace(/```json\n?|```/g, "").trim();
    const result = JSON.parse(cleanText);

    const ref = result.referencia;
    const user = result.alumno;

    // --- LÓGICA DE COMPARACIÓN HÍBRIDA (EL CÓDIGO DECIDE) ---
    
    // 1. Validación de Cruces (Tolerancia de +/- 0 para nudos simples)
    const crucesMatch = user.num_cruces === ref.num_cruces;
    
    // 2. Validación de Bucles
    const buclesMatch = user.num_bucles === ref.num_bucles;
    
    // 3. Validación de Cabos (Crítico para el Rizo/Llano)
    const cabosMatch = user.cabos_paralelos === ref.cabos_paralelos;

    // 4. Decisión Final
    let isCorrect = crucesMatch && buclesMatch && cabosMatch;
    let feedback = "";

    if (isCorrect) {
      feedback = `¡Excelente! Has replicado la estructura del ${ref.tipo} perfectamente.`;
    } else {
      if (!crucesMatch) {
        feedback = `Estructura incorrecta: El nudo debería tener ${ref.num_cruces} cruces, pero hemos detectado ${user.num_cruces}. `;
      } else if (!buclesMatch) {
        feedback = `Fallo en los bucles: Se esperan ${ref.num_bucles} bucles y tu nudo tiene ${user.num_bucles}. `;
      } else if (!cabosMatch) {
        feedback = "Los cabos no salen en la dirección correcta (deben ser paralelos en este nudo). ";
      }
      feedback += result.analisis_diferencial || "Revisa el recorrido de la cuerda.";
    }

    return { isCorrect, feedback };

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

