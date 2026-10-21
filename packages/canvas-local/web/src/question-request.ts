export type QuestionRequest = { id: string; canvas: string; revision: number; text: string }

export const questionRequest = (prior: QuestionRequest | undefined, canvas: string, revision: number, text: string, createId: () => string): QuestionRequest =>
  prior?.canvas === canvas && prior.revision === revision && prior.text === text ? prior : { id: createId(), canvas, revision, text }
