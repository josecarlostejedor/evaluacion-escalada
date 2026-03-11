export enum QuestionType {
  MULTIPLE_CHOICE = 'MULTIPLE_CHOICE',
  FREE_TEXT = 'FREE_TEXT',
  CODE = 'CODE',
  IMAGE_UPLOAD = 'IMAGE_UPLOAD'
}

export enum Discipline {
  KNOTS = 'KNOTS',
  CLIMBING = 'CLIMBING'
}

export interface Question {
  id: string;
  discipline: Discipline;
  type: QuestionType;
  text: string;
  options?: string[]; // For MULTIPLE_CHOICE
  correctAnswer?: string; // For MULTIPLE_CHOICE, FREE_TEXT, CODE
  referenceImageUrl?: string; // For IMAGE_UPLOAD validation
  points: number;
}

export interface StudentData {
  firstName: string;
  lastName: string;
  course: string;
  group: string;
  age: number;
}

export interface Answer {
  questionId: string;
  value: string; // Text, option index, or base64 image
  isCorrect: boolean;
  pointsEarned: number;
}

export interface EvaluationResult {
  student: StudentData;
  discipline: Discipline;
  answers: Answer[];
  totalScore: number;
  maxScore: number;
  date: string;
}
