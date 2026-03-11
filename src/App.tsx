import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  ClipboardCheck, 
  ChevronRight, 
  Camera, 
  CheckCircle2, 
  XCircle, 
  Download, 
  User, 
  Mountain, 
  Link as LinkIcon,
  Loader2,
  ArrowLeft,
  Printer,
  RotateCcw
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { 
  Question, 
  Discipline, 
  QuestionType, 
  StudentData, 
  Answer, 
  EvaluationResult 
} from './types';
import { fetchQuestions, logToGoogleSheets, getMockQuestions } from './services/dataService';
import { validateImageAnswer } from './services/geminiService';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type AppState = 'REGISTRATION' | 'INTRO' | 'DISCIPLINE_SELECT' | 'QUIZ' | 'RESULTS';

export default function App() {
  const [state, setState] = useState<AppState>('REGISTRATION');
  const [student, setStudent] = useState<StudentData>({
    firstName: '',
    lastName: '',
    course: '',
    group: '',
    age: 16
  });
  const [discipline, setDiscipline] = useState<Discipline | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [validatingImage, setValidatingImage] = useState(false);
  const [feedback, setFeedback] = useState<{ isCorrect: boolean; message: string } | null>(null);
  const [attempts, setAttempts] = useState(0);

  const reportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const allQuestions = await fetchQuestions();
        setQuestions(allQuestions);
        setLoadError(null);
      } catch (e: any) {
        console.error("Fetch failed, using mock data", e);
        setLoadError(e.message || "Error al conectar con GitHub");
        setQuestions(getMockQuestions());
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, []);

  const filteredQuestions = questions.filter(q => q.discipline === discipline);
  const currentQuestion = filteredQuestions[currentQuestionIndex];

  const resetApp = () => {
    setStudent({
      firstName: '',
      lastName: '',
      course: '',
      group: '',
      age: 16
    });
    setDiscipline(null);
    setCurrentQuestionIndex(0);
    setAnswers([]);
    setFeedback(null);
    setAttempts(0);
    setState('REGISTRATION');
  };

  const handleRegistrationSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setState('INTRO');
  };

  const startQuiz = (selectedDiscipline: Discipline) => {
    setDiscipline(selectedDiscipline);
    setCurrentQuestionIndex(0);
    setAnswers([]);
    setState('QUIZ');
  };

  const handleAnswer = async (value: string) => {
    if (!currentQuestion || feedback) return;

    let isCorrect = false;
    let pointsEarned = 0;
    let validationFeedback = "";

    if (currentQuestion.type === QuestionType.IMAGE_UPLOAD) {
      setValidatingImage(true);
      const result = await validateImageAnswer(
        value, 
        currentQuestion.referenceImageUrl!, 
        currentQuestion.text
      );
      isCorrect = result.isCorrect;
      validationFeedback = result.feedback;
      setValidatingImage(false);
    } else if (currentQuestion.type === QuestionType.MULTIPLE_CHOICE) {
      const selectedIndex = String(value).trim();
      const correctVal = String(currentQuestion.correctAnswer).trim();
      const selectedText = currentQuestion.options?.[parseInt(selectedIndex)]?.trim();
      
      // Check if the correct answer matches the index OR the text of the option
      isCorrect = selectedIndex === correctVal || (!!selectedText && selectedText === correctVal);
    } else if (currentQuestion.type === QuestionType.CODE || currentQuestion.type === QuestionType.FREE_TEXT) {
      isCorrect = value.toLowerCase().trim() === currentQuestion.correctAnswer?.toLowerCase().trim();
    }

    // Handle retry logic: Only IMAGE_UPLOAD gets a second chance
    if (!isCorrect && attempts === 0 && currentQuestion.type === QuestionType.IMAGE_UPLOAD) {
      setFeedback({ 
        isCorrect: false, 
        message: validationFeedback || "Respuesta incorrecta. Tienes una segunda oportunidad." 
      });
      setAttempts(1);
      return;
    }

    if (isCorrect) {
      pointsEarned = currentQuestion.points;
    }

    const newAnswer: Answer = {
      questionId: currentQuestion.id,
      value,
      isCorrect,
      pointsEarned
    };

    const updatedAnswers = [...answers, newAnswer];
    setAnswers(updatedAnswers);
    setAttempts(2); // Mark as second attempt finished
    setFeedback({ isCorrect, message: validationFeedback || (isCorrect ? "¡Correcto!" : "Incorrecto") });
  };

  const handleNext = () => {
    setFeedback(null);
    setAttempts(0);
    if (currentQuestionIndex < filteredQuestions.length - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
    } else {
      finishQuiz(answers);
    }
  };

  const finishQuiz = async (finalAnswers: Answer[]) => {
    const totalScore = finalAnswers.reduce((acc, curr) => acc + curr.pointsEarned, 0);
    const maxScore = filteredQuestions.reduce((acc, curr) => acc + curr.points, 0);
    
    const result: EvaluationResult = {
      student,
      discipline: discipline!,
      answers: finalAnswers,
      totalScore,
      maxScore,
      date: new Date().toLocaleString()
    };

    setIsLoading(true);
    await logToGoogleSheets(result);
    setIsLoading(false);
    setState('RESULTS');
  };

  const downloadPDF = async () => {
    if (!reportRef.current) return;
    setIsLoading(true);
    try {
      // Ensure all images in the report are loaded before starting
      const images = reportRef.current.getElementsByTagName('img');
      const imagePromises = Array.from(images).map(img => {
        if (img.complete) return Promise.resolve();
        return new Promise(resolve => {
          img.onload = resolve;
          img.onerror = resolve;
        });
      });
      await Promise.all(imagePromises);
      
      // Small extra delay for rendering
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 15;
      const footerHeight = 20;
      const maxContentHeight = pageHeight - footerHeight;
      
      let currentY = margin;
      let pageNumber = 1;

      const addFooter = (p: number) => {
        pdf.setFontSize(9);
        pdf.setTextColor(150, 150, 150);
        pdf.text(`Página ${p} | Evaluación IES Lucía de Medrano`, pageWidth / 2, pageHeight - 10, { align: 'center' });
      };

      const addElementToPdf = async (element: HTMLElement) => {
        if (!element) return;
        try {
          const canvas = await html2canvas(element, {
            useCORS: true,
            scale: 2,
            logging: false,
            backgroundColor: '#ffffff',
            allowTaint: false,
            imageTimeout: 15000,
            scrollY: 0,
            windowWidth: 800
          });
          
          const imgData = canvas.toDataURL('image/png', 1.0);
          const imgWidth = pageWidth - (margin * 2);
          const imgHeight = (canvas.height * imgWidth) / canvas.width;

          if (currentY + imgHeight > maxContentHeight) {
            addFooter(pageNumber);
            pdf.addPage();
            pageNumber++;
            currentY = margin;
          }

          pdf.addImage(imgData, 'PNG', margin, currentY, imgWidth, imgHeight, undefined, 'FAST');
          currentY += imgHeight + 8;
        } catch (err) {
          console.error("Error capturing element:", err);
        }
      };

      const report = reportRef.current;
      const children = Array.from(report.children) as HTMLElement[];
      
      for (const child of children) {
        // If it's the questions container, process its children individually for better page breaking
        if (child.classList.contains('space-y-10')) {
          const qChildren = Array.from(child.children) as HTMLElement[];
          for (const qChild of qChildren) {
            await addElementToPdf(qChild);
            // Small delay to prevent UI blocking and ensure rendering
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        } else {
          await addElementToPdf(child);
        }
      }
      
      addFooter(pageNumber);
      pdf.save(`Evaluacion_${student.lastName}_${student.firstName}.pdf`);
    } catch (error) {
      console.error("Error generating PDF:", error);
      alert("No se pudo generar el PDF. Asegúrate de tener una buena conexión y de que las imágenes se hayan cargado correctamente.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f5f5f0] text-[#1a1a1a] font-serif selection:bg-[#5A5A40] selection:text-white">
      <header className="p-6 border-b border-[#1a1a1a]/10 flex justify-between items-center bg-white/50 backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-[#5A5A40] rounded-full flex items-center justify-center text-white">
            <Mountain size={20} />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">EvaluaEscalada</h1>
            <p className="text-xs uppercase tracking-widest opacity-60">IES Lucía de Medrano</p>
          </div>
        </div>
        {state !== 'REGISTRATION' && (
          <div className="text-right hidden sm:block">
            <p className="text-sm font-medium">{student.firstName} {student.lastName}</p>
            <p className="text-xs opacity-60">{student.course} - {student.group}</p>
          </div>
        )}
      </header>

      {isLoading && (
        <div className="fixed inset-0 bg-white/80 backdrop-blur-sm z-[100] flex flex-col items-center justify-center">
          <Loader2 size={48} className="text-[#5A5A40] animate-spin mb-4" />
          <p className="text-[#5A5A40] font-bold animate-pulse">Generando Informe PDF...</p>
          <p className="text-xs opacity-60 mt-2">Por favor, espera un momento.</p>
        </div>
      )}

      <main className="max-w-4xl mx-auto p-6 py-12">
        <AnimatePresence mode="wait">
          {state === 'REGISTRATION' && (
            <motion.div
              key="reg"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="bg-white rounded-[32px] p-8 shadow-xl shadow-black/5 border border-black/5"
            >
              {/* Header Section */}
              <div className="text-center mb-10 border-b border-black/5 pb-8">
                <div className="space-y-1 mb-8">
                  <h3 className="text-xl font-medium text-[#5A5A40] italic">Situación de Aprendizaje: "Trepa y Escalada"</h3>
                  <p className="text-lg font-bold tracking-[0.15em] uppercase">- IES LUCÍA DE MEDRANO -</p>
                  <p className="text-xs opacity-60 uppercase tracking-[0.2em]">Departamento de Educación Física</p>
                </div>
                <img 
                  src="https://raw.githubusercontent.com/josecarlostejedor/evaluacion-escalada/main/escladaytrepaini.jpg" 
                  alt="Escalada y Trepa" 
                  className="w-full max-w-md mx-auto rounded-3xl shadow-lg border border-black/5"
                  referrerPolicy="no-referrer"
                />
              </div>

              <div className="mb-8">
                <h2 className="text-3xl font-light mb-2">Registro del Alumno</h2>
                <p className="text-[#5A5A40] italic">Completa tus datos para comenzar la evaluación.</p>
                {loadError && (
                  <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-xl text-red-800 text-sm">
                    <p className="font-bold mb-1 flex items-center gap-2">
                      <XCircle size={16} /> Error al cargar preguntas remotas
                    </p>
                    <p className="opacity-80 mb-2">{loadError}</p>
                    <p className="text-xs italic">Se están utilizando preguntas de ejemplo mientras se soluciona el problema.</p>
                  </div>
                )}
                {!loadError && isLoading && (
                  <div className="mt-4 flex items-center gap-2 text-[#5A5A40] text-sm animate-pulse">
                    <Loader2 size={16} className="animate-spin" />
                    Cargando preguntas desde GitHub...
                  </div>
                )}
                {!loadError && !isLoading && questions.length > 0 && (
                  <div className="mt-4 flex items-center gap-2 text-green-700 text-sm">
                    <CheckCircle2 size={16} /> Preguntas cargadas correctamente desde Excel.
                  </div>
                )}
              </div>
              <form onSubmit={handleRegistrationSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-xs uppercase tracking-widest font-bold opacity-60">Nombre</label>
                  <input
                    required
                    className="w-full px-4 py-3 rounded-xl border border-black/10 focus:border-[#5A5A40] focus:ring-1 focus:ring-[#5A5A40] outline-none transition-all"
                    value={student.firstName}
                    onChange={e => setStudent({ ...student, firstName: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs uppercase tracking-widest font-bold opacity-60">Apellidos</label>
                  <input
                    required
                    className="w-full px-4 py-3 rounded-xl border border-black/10 focus:border-[#5A5A40] focus:ring-1 focus:ring-[#5A5A40] outline-none transition-all"
                    value={student.lastName}
                    onChange={e => setStudent({ ...student, lastName: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs uppercase tracking-widest font-bold opacity-60">Curso</label>
                  <select
                    className="w-full px-4 py-3 rounded-xl border border-black/10 focus:border-[#5A5A40] outline-none"
                    value={student.course}
                    onChange={e => setStudent({ ...student, course: e.target.value })}
                  >
                    <option value="">Selecciona curso</option>
                    <option value="1º ESO">1º ESO</option>
                    <option value="2º ESO">2º ESO</option>
                    <option value="3º ESO">3º ESO</option>
                    <option value="4º ESO">4º ESO</option>
                    <option value="1º BACH">1º BACH</option>
                    <option value="2º BACH">2º BACH</option>
                    <option value="FP">FP</option>
                    <option value="OTRO NIVEL">OTRO NIVEL</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-xs uppercase tracking-widest font-bold opacity-60">Grupo</label>
                  <select
                    className="w-full px-4 py-3 rounded-xl border border-black/10 focus:border-[#5A5A40] outline-none"
                    value={student.group}
                    onChange={e => setStudent({ ...student, group: e.target.value })}
                  >
                    <option value="">Selecciona grupo</option>
                    <option value="1">1</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                    <option value="4">4</option>
                    <option value="5">5</option>
                    <option value="6">6</option>
                    <option value="7">7</option>
                  </select>
                </div>
                <div className="md:col-span-2 pt-4">
                  <button
                    type="submit"
                    className="w-full bg-[#5A5A40] text-white py-4 rounded-full font-medium hover:bg-[#4a4a35] transition-colors flex items-center justify-center gap-2 group"
                  >
                    Continuar <ChevronRight size={18} className="group-hover:translate-x-1 transition-transform" />
                  </button>
                </div>
              </form>

              {/* Footer Section */}
              <div className="mt-12 pt-8 border-t border-black/5 text-center space-y-1">
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#5A5A40]">PROYECTO INICIACIÓN A LA ESCALADA Y TREPA</p>
                <p className="text-[10px] uppercase tracking-widest opacity-40">APP creada por Jose Carlos Tejedor</p>
              </div>
            </motion.div>
          )}

          {state === 'INTRO' && (
            <motion.div
              key="intro"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-8"
            >
              <div className="text-center mb-12">
                <h2 className="text-4xl font-light mb-4 text-balance">Unidad de Trabajo: Trepa y Escalada</h2>
                <p className="text-lg text-[#5A5A40] italic max-w-2xl mx-auto">
                  Bienvenido a la evaluación práctica. Selecciona la disciplina que vas a evaluar hoy.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <IntroCard
                  title="Cabuyería"
                  description="Evaluación de nudos básicos y avanzados. Seguridad y aplicaciones prácticas."
                  image="https://raw.githubusercontent.com/josecarlostejedor/evaluacion-escalada/main/cabuyeria2ini.jpg"
                  onClick={() => startQuiz(Discipline.KNOTS)}
                  icon={<LinkIcon />}
                />
                <IntroCard
                  title="Escalada"
                  description="Técnica de progresión, aseguramiento y protocolos de seguridad en pared."
                  image="https://raw.githubusercontent.com/josecarlostejedor/evaluacion-escalada/main/escaladainisegundapagina.jpg"
                  onClick={() => startQuiz(Discipline.CLIMBING)}
                  icon={<Mountain />}
                />
              </div>

              <div className="flex justify-center pt-8">
                <button
                  onClick={() => setState('REGISTRATION')}
                  className="text-[#5A5A40] font-medium flex items-center gap-2 hover:opacity-70 transition-opacity"
                >
                  <ArrowLeft size={18} /> Volver al registro
                </button>
              </div>
            </motion.div>
          )}

          {state === 'QUIZ' && filteredQuestions.length === 0 && (
            <motion.div
              key="no-questions"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-white rounded-[32px] p-12 shadow-sm text-center space-y-6"
            >
              <div className="w-20 h-20 bg-[#f5f5f0] rounded-full flex items-center justify-center text-[#5A5A40] mx-auto">
                <ClipboardCheck size={32} />
              </div>
              <h3 className="text-2xl font-bold">No hay preguntas disponibles</h3>
              <p className="text-lg opacity-60">
                Aún no se han cargado preguntas válidas para esta disciplina en la base de datos.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <button
                  onClick={() => setState('INTRO')}
                  className="bg-[#5A5A40] text-white px-8 py-3 rounded-full font-medium hover:bg-[#4a4a35] transition-all flex items-center gap-2 justify-center"
                >
                  <ArrowLeft size={18} /> Volver a disciplinas
                </button>
                <button
                  onClick={() => setState('REGISTRATION')}
                  className="border border-[#5A5A40] text-[#5A5A40] px-8 py-3 rounded-full font-medium hover:bg-[#5A5A40] hover:text-white transition-all flex items-center gap-2 justify-center"
                >
                  <RotateCcw size={18} /> Volver al inicio
                </button>
              </div>
            </motion.div>
          )}

          {state === 'QUIZ' && currentQuestion && (
            <motion.div
              key="quiz"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="bg-white rounded-[32px] p-8 shadow-xl border border-black/5 relative overflow-hidden"
            >
              <div className="flex justify-between items-center mb-8">
                <span className="text-xs uppercase tracking-widest font-bold text-[#5A5A40]">
                  Pregunta {currentQuestionIndex + 1} de {filteredQuestions.length}
                </span>
                <span className="bg-[#f5f5f0] px-3 py-1 rounded-full text-xs font-bold">
                  {currentQuestion.points} Puntos
                </span>
              </div>

              <h3 className="text-2xl mb-8 leading-tight">{currentQuestion.text}</h3>

              {currentQuestion.referenceImageUrl && currentQuestion.type !== QuestionType.IMAGE_UPLOAD && (
                <div className="mb-8 overflow-hidden rounded-3xl bg-[#f5f5f0]/50 border border-black/5 shadow-sm">
                  <img 
                    src={currentQuestion.referenceImageUrl} 
                    alt="Referencia" 
                    className="w-full h-auto max-h-[300px] object-contain mx-auto"
                    referrerPolicy="no-referrer"
                  />
                </div>
              )}

              <div className="space-y-4">
                {currentQuestion.type === QuestionType.MULTIPLE_CHOICE && (
                  <div className="grid gap-3">
                    {currentQuestion.options?.map((opt, i) => (
                      <button
                        key={i}
                        disabled={!!feedback}
                        onClick={() => handleAnswer(i.toString())}
                        className={cn(
                          "w-full text-left p-4 rounded-2xl border border-black/10 hover:border-[#5A5A40] hover:bg-[#f5f5f0] transition-all flex items-center justify-between group",
                          feedback && "opacity-50 cursor-not-allowed"
                        )}
                      >
                        <span>{opt}</span>
                        <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                      </button>
                    ))}
                  </div>
                )}

                {currentQuestion.type === QuestionType.CODE && (
                  <div className="space-y-4">
                    <input
                      type="text"
                      placeholder="Introduce el código..."
                      className="w-full p-4 rounded-2xl border border-black/10 text-center text-2xl tracking-widest font-mono outline-none focus:border-[#5A5A40]"
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleAnswer((e.target as HTMLInputElement).value);
                      }}
                    />
                    <p className="text-xs text-center opacity-40">Presiona Enter para validar</p>
                  </div>
                )}

                {currentQuestion.type === QuestionType.FREE_TEXT && (
                  <textarea
                    className="w-full p-4 rounded-2xl border border-black/10 min-h-[150px] outline-none focus:border-[#5A5A40]"
                    placeholder="Escribe tu respuesta aquí..."
                    onKeyDown={e => {
                      if (e.key === 'Enter' && e.ctrlKey) handleAnswer((e.target as HTMLTextAreaElement).value);
                    }}
                  />
                )}

                {currentQuestion.type === QuestionType.IMAGE_UPLOAD && (
                  <div className="space-y-6">
                    <div className="flex flex-col items-center gap-6 py-8 border-2 border-dashed border-black/10 rounded-[32px]">
                      <div className="w-20 h-20 bg-[#f5f5f0] rounded-full flex items-center justify-center text-[#5A5A40]">
                        <Camera size={32} />
                      </div>
                      <div className="text-center">
                        <p className="font-medium">Sube una fotografía de tu ejecución</p>
                        <p className="text-sm opacity-60">Asegúrate de que el nudo sea claramente visible</p>
                      </div>
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        id="camera-input"
                        onChange={async e => {
                          const file = e.target.files?.[0];
                          if (file) {
                            const reader = new FileReader();
                            reader.onload = () => handleAnswer(reader.result as string);
                            reader.readAsDataURL(file);
                          }
                        }}
                      />
                      <label
                        htmlFor="camera-input"
                        className="bg-[#5A5A40] text-white px-8 py-3 rounded-full cursor-pointer hover:bg-[#4a4a35] transition-colors flex items-center gap-2"
                      >
                        {validatingImage ? <Loader2 className="animate-spin" /> : <Camera size={18} />}
                        {validatingImage ? "Validando..." : "Tomar Foto"}
                      </label>
                    </div>
                  </div>
                )}
              </div>

              <AnimatePresence>
                {feedback && (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className={cn(
                      "absolute inset-0 flex flex-col items-center justify-center bg-white/95 backdrop-blur-sm z-10 p-8 text-center",
                      feedback.isCorrect ? "text-green-700" : "text-red-700"
                    )}
                  >
                    {feedback.isCorrect ? <CheckCircle2 size={64} className="mb-4" /> : <XCircle size={64} className="mb-4" />}
                    <h4 className="text-3xl font-bold mb-2">{feedback.isCorrect ? "¡Excelente!" : "Revisa la técnica"}</h4>
                    <p className="text-lg italic opacity-80 mb-4">{feedback.message}</p>
                    
                    <div className="mb-8 bg-[#f5f5f0]/50 px-6 py-2 rounded-full">
                      <p className="text-sm font-bold uppercase tracking-widest text-[#5A5A40]">
                        Puntuación actual: {answers.reduce((a, c) => a + c.pointsEarned, 0)}
                      </p>
                    </div>
                    
                    <div className="flex gap-4">
                      {!feedback.isCorrect && attempts === 1 && (
                        <button
                          onClick={() => setFeedback(null)}
                          className="bg-[#5A5A40] text-white px-8 py-3 rounded-full font-medium hover:bg-[#4a4a35] transition-all flex items-center gap-2"
                        >
                          {currentQuestion.type === QuestionType.IMAGE_UPLOAD ? <Camera size={18} /> : <RotateCcw size={18} />} Reintentar
                        </button>
                      )}
                      
                      {/* Show Next button if it's correct OR if it's the second attempt */}
                      {(feedback.isCorrect || attempts === 2) && (
                        <button
                          onClick={handleNext}
                          className="bg-[#5A5A40] text-white px-8 py-3 rounded-full font-medium hover:bg-[#4a4a35] transition-all flex items-center gap-2"
                        >
                          Siguiente <ChevronRight size={18} />
                        </button>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="mt-8 h-1 bg-[#f5f5f0] rounded-full overflow-hidden">
                <motion.div 
                  className="h-full bg-[#5A5A40]"
                  initial={{ width: 0 }}
                  animate={{ width: `${((currentQuestionIndex) / filteredQuestions.length) * 100}%` }}
                />
              </div>
            </motion.div>
          )}

          {state === 'RESULTS' && (
            <motion.div
              key="results"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="space-y-8"
            >
              <div className="bg-white rounded-[32px] p-12 shadow-2xl border border-black/5 text-center relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-2 bg-[#5A5A40]" />
                <CheckCircle2 size={80} className="mx-auto mb-6 text-green-600" />
                <h2 className="text-4xl font-light mb-2">Evaluación Completada</h2>
                
                {(() => {
                  const score = answers.reduce((a, c) => a + c.pointsEarned, 0);
                  const max = filteredQuestions.reduce((a, c) => a + c.points, 0);
                  const percentage = (score / max) * 100;
                  
                  let message = "Buen trabajo, " + student.firstName + ".";
                  if (percentage >= 90) message = "¡Increíble, " + student.firstName + "! Eres un experto en la materia.";
                  else if (percentage >= 70) message = "¡Muy bien, " + student.firstName + "! Tienes un gran dominio técnico.";
                  else if (percentage >= 50) message = "¡Aprobado, " + student.firstName + "! Sigue practicando para perfeccionar.";
                  else message = "No te desanimes, " + student.firstName + ". Repasa los conceptos y vuelve a intentarlo.";
                  
                  return <p className="text-xl text-[#5A5A40] italic mb-8">{message}</p>;
                })()}
                
                <div className="flex justify-center gap-12 mb-8">
                  <div className="text-center">
                    <p className="text-xs uppercase tracking-widest opacity-60 mb-1">Puntuación</p>
                    <p className="text-5xl font-bold">{answers.reduce((a, c) => a + c.pointsEarned, 0)}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs uppercase tracking-widest opacity-60 mb-1">Máximo</p>
                    <p className="text-5xl font-bold opacity-20">{filteredQuestions.reduce((a, c) => a + c.points, 0)}</p>
                  </div>
                </div>

                <div className="mb-12 p-4 bg-[#f5f5f0] rounded-2xl inline-block">
                  <p className="text-sm uppercase tracking-widest font-bold text-[#5A5A40] mb-1">Nota Final</p>
                  <p className="text-3xl font-bold">
                    {(() => {
                      const score = answers.reduce((a, c) => a + c.pointsEarned, 0);
                      const max = filteredQuestions.reduce((a, c) => a + c.points, 0);
                      return max > 0 ? ((score / max) * 10).toFixed(2) : "0.00";
                    })()} / 10.00
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row gap-4 justify-center">
                  <button
                    onClick={downloadPDF}
                    className="bg-[#5A5A40] text-white px-8 py-4 rounded-full font-medium hover:bg-[#4a4a35] transition-all flex items-center justify-center gap-2"
                  >
                    <Download size={18} /> Descargar Informe PDF
                  </button>
                  <button
                    onClick={resetApp}
                    className="border border-[#5A5A40] text-[#5A5A40] px-8 py-4 rounded-full font-medium hover:bg-[#5A5A40] hover:text-white transition-all flex items-center justify-center gap-2"
                  >
                    <ArrowLeft size={18} /> Repetir Evaluación
                  </button>
                </div>
              </div>

              {/* Report for PDF Generation - Hidden from view but accessible to html2canvas */}
              <div className="absolute left-[-9999px] top-0 overflow-hidden">
                <div ref={reportRef} className="p-12 w-[800px] bg-white" style={{ color: '#000000', fontFamily: 'Arial, sans-serif', textRendering: 'geometricPrecision' }}>
                  <div className="pb-8 mb-8 grid grid-cols-12 items-end" style={{ borderBottom: '3px solid #000000' }}>
                    <div className="col-span-8">
                      <h1 className="text-5xl font-bold" style={{ letterSpacing: '0', marginBottom: '8px' }}>Informe de Evaluación</h1>
                      <p className="text-xl">IES Lucía de Medrano &bull; Dept. Educación Física</p>
                    </div>
                    <div className="col-span-4 text-right">
                      <p className="font-bold text-xl mb-1">{new Date().toLocaleDateString()}</p>
                      <p className="uppercase tracking-[0.1em] text-xs font-bold" style={{ opacity: 0.5 }}>{discipline === Discipline.KNOTS ? 'Cabuyería' : 'Escalada'}</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-12 mb-12 p-8 rounded-2xl" style={{ backgroundColor: '#f8f9fa', border: '1px solid #e9ecef' }}>
                    <div>
                      <p className="text-[10px] uppercase font-bold tracking-widest mb-2" style={{ opacity: 0.4 }}>Alumno</p>
                      <p className="text-2xl font-bold">{student.lastName}, {student.firstName}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase font-bold tracking-widest mb-2" style={{ opacity: 0.4 }}>Curso y Grupo</p>
                      <p className="text-2xl font-bold">{student.course} - {student.group}</p>
                    </div>
                  </div>

                  <div className="space-y-10">
                    <h3 className="text-3xl font-bold pb-4 mb-6" style={{ borderBottom: '2px solid #000000' }}>Desglose de Respuestas</h3>
                    {filteredQuestions.map((q, i) => {
                      const ans = answers.find(a => a.questionId === q.id);
                      
                      // Format the answer display
                      let displayValue = ans?.value || 'Sin respuesta';
                      if (q.type === QuestionType.MULTIPLE_CHOICE && ans) {
                        const optIndex = parseInt(ans.value);
                        displayValue = q.options?.[optIndex] || ans.value;
                      }

                      return (
                        <div key={q.id} className="pb-8" style={{ borderBottom: '1px solid #e9ecef', breakInside: 'avoid', pageBreakInside: 'avoid' }}>
                          <div className="flex justify-between items-start mb-6">
                            <div className="flex-1 pr-12">
                              <p className="font-bold text-xs uppercase tracking-widest mb-2" style={{ opacity: 0.4 }}>Pregunta {i + 1}</p>
                              <p className="text-xl font-bold leading-normal">{q.text}</p>
                            </div>
                            <div className="text-right min-w-[100px]">
                              <p className="font-bold text-2xl" style={{ color: ans?.isCorrect ? '#16a34a' : '#dc2626' }}>
                                {ans?.pointsEarned || 0} / {q.points}
                              </p>
                              <p className="text-[10px] uppercase font-bold tracking-widest">{ans?.isCorrect ? 'Correcto' : 'Incorrecto'}</p>
                            </div>
                          </div>
                          
                          <div className="p-6 rounded-xl" style={{ backgroundColor: '#f8f9fa' }}>
                            <p className="text-[10px] uppercase font-bold tracking-widest opacity-40 mb-3">Respuesta del Alumno:</p>
                            {q.type === QuestionType.IMAGE_UPLOAD && ans?.value ? (
                              <div className="flex gap-4 items-start">
                                <div className="flex-1">
                                  <p className="text-xs mb-3 italic opacity-60">Imagen enviada:</p>
                                  <img 
                                    src={ans.value} 
                                    alt="Respuesta alumno" 
                                    className="max-h-64 rounded-lg"
                                    style={{ border: '1px solid #dee2e6', display: 'block' }}
                                    referrerPolicy="no-referrer"
                                    crossOrigin="anonymous"
                                  />
                                </div>
                              </div>
                            ) : (
                              <div className="space-y-6">
                                <p className="text-xl italic font-medium">"{displayValue}"</p>
                                {q.referenceImageUrl && (
                                  <div>
                                    <p className="text-xs mb-3 italic opacity-60">Imagen de referencia:</p>
                                    <img 
                                      src={q.referenceImageUrl} 
                                      alt="Referencia" 
                                      className="max-h-64 rounded-lg"
                                      style={{ border: '1px solid #dee2e6', opacity: 0.7, display: 'block' }}
                                      referrerPolicy="no-referrer"
                                      crossOrigin="anonymous"
                                    />
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-16 pt-10 pb-10" style={{ borderTop: '3px solid #000000' }}>
                    <div>
                      <p className="text-4xl font-bold">Puntuación Final: {answers.reduce((a, c) => a + c.pointsEarned, 0)} / {filteredQuestions.reduce((a, c) => a + c.points, 0)}</p>
                      <p className="text-2xl font-bold mt-4" style={{ color: '#5A5A40' }}>
                        Puntuación sobre 10 puntos: {(() => {
                          const score = answers.reduce((a, c) => a + c.pointsEarned, 0);
                          const max = filteredQuestions.reduce((a, c) => a + c.points, 0);
                          return max > 0 ? ((score / max) * 10).toFixed(2) : "0.00";
                        })()} / 10.00
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="p-12 text-center opacity-40 text-xs uppercase tracking-[0.2em]">
        &copy; {new Date().getFullYear()} IES Lucía de Medrano &bull; Departamento de Educación Física
      </footer>
    </div>
  );
}

function IntroCard({ title, description, image, onClick, icon }: { 
  title: string; 
  description: string; 
  image: string; 
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <motion.button
      whileHover={{ y: -8 }}
      onClick={onClick}
      className="group bg-white rounded-[32px] overflow-hidden shadow-lg border border-black/5 text-left transition-all hover:shadow-2xl"
    >
      <div className="h-48 overflow-hidden relative">
        <img src={image} alt={title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" referrerPolicy="no-referrer" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
        <div className="absolute bottom-4 left-6 text-white flex items-center gap-2">
          <div className="w-8 h-8 bg-white/20 backdrop-blur-md rounded-full flex items-center justify-center">
            {icon}
          </div>
          <span className="font-bold tracking-tight text-xl">{title}</span>
        </div>
      </div>
      <div className="p-6">
        <p className="text-[#1a1a1a]/60 leading-relaxed mb-6">{description}</p>
        <div className="flex items-center text-[#5A5A40] font-bold text-sm uppercase tracking-widest">
          Comenzar Evaluación <ChevronRight size={16} className="ml-1 group-hover:translate-x-1 transition-transform" />
        </div>
      </div>
    </motion.button>
  );
}
