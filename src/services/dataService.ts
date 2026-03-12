import * as XLSX from 'xlsx';
import { Question, Discipline, QuestionType, EvaluationResult } from '../types';

// Default Excel URL (User should replace this with their GitHub Raw URL)
const DEFAULT_EXCEL_URL = 'https://github.com/josecarlostejedor/evaluacion-escalada/blob/main/preguntasescalada.xlsx';

// Helper to convert GitHub UI URLs to Raw URLs
function getRawUrl(url: string): string {
  if (!url) return url;
  if (url.includes('github.com') && url.includes('/blob/')) {
    return url
      .replace('github.com', 'raw.githubusercontent.com')
      .replace('/blob/', '/');
  }
  return url;
}

export async function fetchQuestions(excelUrl: string = DEFAULT_EXCEL_URL): Promise<Question[]> {
  const finalUrl = getRawUrl(excelUrl);
  try {
    if (!finalUrl || finalUrl.includes('MY_APP_URL')) {
      console.warn('Excel URL not configured. Using mock questions.');
      return getMockQuestions();
    }

    console.log('Fetching questions from:', finalUrl);
    const response = await fetch(finalUrl);
    if (!response.ok) {
      throw new Error(`Error al descargar el archivo: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    
    // Use header: 1 to get an array of arrays, which is more predictable for mapping
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

    if (!rows || rows.length === 0) {
      throw new Error('El archivo Excel está vacío.');
    }

    // Try to find the header row or assume the first row is data if it looks like it
    let headerRowIndex = 0;
    let hasHeaders = false;
    
    // Look for a row that contains keywords like "type", "text", "discipline"
    for (let i = 0; i < Math.min(rows.length, 5); i++) {
      const rowStr = rows[i].join('|').toLowerCase();
      if (
        rowStr.includes('type') || 
        rowStr.includes('tipo') || 
        rowStr.includes('text') || 
        rowStr.includes('pregunta') ||
        rowStr.includes('disciplina') ||
        rowStr.includes('respuesta') ||
        rowStr.includes('opciones')
      ) {
        headerRowIndex = i;
        hasHeaders = true;
        break;
      }
    }

    const headers = hasHeaders ? rows[headerRowIndex].map(h => String(h || '').toLowerCase().replace(/[\s_]/g, '')) : [];
    const dataRows = rows.slice(hasHeaders ? headerRowIndex + 1 : 0);

    const questions = dataRows.map((row: any[], rowIndex: number) => {
      if (!row || row.length === 0) return null;

      // Helper to get value by header name or by common index
      const getVal = (possibleHeaders: string[], defaultIndex: number) => {
        if (hasHeaders) {
          for (const pHeader of possibleHeaders) {
            const idx = headers.indexOf(pHeader.toLowerCase().replace(/[\s_]/g, ''));
            if (idx !== -1) return row[idx];
          }
        }
        // Fallback to default index if within bounds
        return row[defaultIndex];
      };

      const rawId = getVal(['id'], 0);
      const rawDiscipline = String(getVal(['discipline', 'disciplina'], 1) || '').toUpperCase();
      const rawType = String(getVal(['type', 'tipo'], 2) || '').toUpperCase();
      const rawText = getVal(['text', 'pregunta', 'texto'], 3);
      const rawOptions = getVal(['options', 'opciones'], 4);
      const rawCorrectAnswer = getVal(['correctanswer', 'respuestacorrecta', 'respuesta'], 5);
      const rawImageUrl = getVal(['referenceimagenurl', 'referenceimageurl', 'imagen', 'imageurl', 'urlimagen', 'foto', 'fotoreferencia', 'url'], 6);
      const rawPoints = getVal(['points', 'puntos'], 7);

      if (!rawText) return null;

      // Type mapping
      let type = QuestionType.MULTIPLE_CHOICE;
      if (rawType.includes('IMAGEN') || rawType.includes('IMAGE') || rawType.includes('FOTO')) {
        type = QuestionType.IMAGE_UPLOAD;
      } else if (rawType.includes('TEST') || rawType.includes('CHOICE') || rawType.includes('OPCION')) {
        type = QuestionType.MULTIPLE_CHOICE;
      } else if (rawType.includes('TEXT') || rawType.includes('LIBRE')) {
        type = QuestionType.FREE_TEXT;
      } else if (rawType.includes('CODE') || rawType.includes('CODIGO')) {
        type = QuestionType.CODE;
      }

      // Discipline mapping
      let discipline = Discipline.KNOTS;
      if (rawDiscipline.includes('NUDO') || rawDiscipline.includes('KNOT') || rawDiscipline.includes('CABUYERIA')) {
        discipline = Discipline.KNOTS;
      } else if (rawDiscipline.includes('ESCALADA') || rawDiscipline.includes('CLIMB') || rawDiscipline.includes('ROCA')) {
        discipline = Discipline.CLIMBING;
      }

      return {
        id: String(rawId || `q-${rowIndex}-${Math.random().toString(36).substr(2, 5)}`),
        discipline: discipline as Discipline,
        type: type as QuestionType,
        text: String(rawText).trim(),
        options: rawOptions ? String(rawOptions).split('|').map(o => o.trim()) : undefined,
        correctAnswer: String(rawCorrectAnswer !== undefined ? rawCorrectAnswer : '').trim(),
        referenceImageUrl: rawImageUrl ? getRawUrl(String(rawImageUrl).trim()) : undefined,
        points: parseInt(String(rawPoints || '0'), 10),
      } as Question;
    }).filter(q => q !== null) as Question[];

    // Final filter: must have text and if it's multiple choice, it must have options
    return questions.filter((q: Question) => {
      const hasText = q.text && q.text.trim().length > 0;
      if (!hasText) return false;

      if (q.type === QuestionType.MULTIPLE_CHOICE) {
        return !!q.options && q.options.length > 1;
      }
      return true;
    });
  } catch (error) {
    console.error('Error fetching questions from:', finalUrl, error);
    // We throw the error so the UI can catch it and show a message
    throw error;
  }
}

export function getMockQuestions(): Question[] {
  return [
    {
      id: '1',
      discipline: Discipline.KNOTS,
      type: QuestionType.MULTIPLE_CHOICE,
      text: '¿Cuál de estos nudos es el más adecuado para encordarse al arnés?',
      options: ['Ocho doble', 'As de guía', 'Nudo de alondra', 'Ballestrinque'],
      correctAnswer: '0',
      points: 2
    },
    {
      id: '2',
      discipline: Discipline.KNOTS,
      type: QuestionType.IMAGE_UPLOAD,
      text: 'Realiza un nudo de ocho doble y sube una foto clara.',
      referenceImageUrl: 'https://picsum.photos/seed/knot8/400/300',
      points: 5
    },
    {
      id: '3',
      discipline: Discipline.CLIMBING,
      type: QuestionType.CODE,
      text: 'Introduce el código de seguridad de 4 dígitos que aparece en la placa del rocódromo sector A.',
      correctAnswer: '1234',
      points: 3
    }
  ];
}

export async function logToGoogleSheets(result: EvaluationResult) {
  const SCRIPT_URL = import.meta.env.VITE_GOOGLE_SHEETS_URL || (typeof process !== 'undefined' && process.env.VITE_GOOGLE_SHEETS_URL);
  if (!SCRIPT_URL) {
    console.warn("Google Sheets URL not configured. Data:", result);
    return;
  }

  // Calculate score over 10
  const scoreOver10 = result.maxScore > 0 ? ((result.totalScore / result.maxScore) * 10).toFixed(2) : "0.00";
  
  // Persist score in localStorage to calculate average across disciplines
  const studentKey = `${result.student.firstName}_${result.student.lastName}_${result.student.course}_${result.student.group}`.replace(/\s+/g, '_').toLowerCase();
  const storageKey = `eval_scores_${studentKey}`;
  const savedScores = JSON.parse(localStorage.getItem(storageKey) || '{}');
  
  // Update saved scores
  savedScores[result.discipline] = scoreOver10;
  localStorage.setItem(storageKey, JSON.stringify(savedScores));

  // Calculate average if both scores are present
  let mediaFinal = '';
  if (savedScores[Discipline.KNOTS] && savedScores[Discipline.CLIMBING]) {
    const n1 = parseFloat(savedScores[Discipline.KNOTS]);
    const n2 = parseFloat(savedScores[Discipline.CLIMBING]);
    mediaFinal = ((n1 + n2) / 2).toFixed(2);
  }

  // Count mistakes
  const mistakes = result.answers.filter(a => !a.isCorrect).length;

  const payload = {
    nombre: result.student.firstName,
    apellidos: result.student.lastName,
    curso: result.student.course,
    grupo: result.student.group,
    edad: result.student.age,
    puntuacion_cabuyeria: result.discipline === Discipline.KNOTS ? scoreOver10 : '',
    fallos_cabuyeria: result.discipline === Discipline.KNOTS ? mistakes : '',
    puntuacion_escalada: result.discipline === Discipline.CLIMBING ? scoreOver10 : '',
    fallos_escalada: result.discipline === Discipline.CLIMBING ? mistakes : '',
    fecha_cabuyeria: result.discipline === Discipline.KNOTS ? result.date : '',
    fecha_escalada: result.discipline === Discipline.CLIMBING ? result.date : '',
    nota_media: mediaFinal
  };

  try {
    await fetch(SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error('Error logging to Google Sheets:', error);
  }
}
