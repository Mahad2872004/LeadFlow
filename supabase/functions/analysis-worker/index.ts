import { createAnalysisWorkerHandler } from './handler.ts'
import { geminiClient } from '../_shared/analysis/gemini.ts'
const env=(name:string)=>Deno.env.get(name)
Deno.serve(createAnalysisWorkerHandler({env,fetch},{ai:geminiClient(env)}))
