import { createProjectAssistantHandler } from './handler.ts'
import { geminiClient, geminiModel } from '../_shared/analysis/gemini.ts'
const env=(name:string)=>Deno.env.get(name)
// The assistant uses PROJECT_AI_MODEL when it is set, otherwise the business analysis model (ANALYSIS_AI_MODEL or the default).
const assistantEnv=(name:string)=>name==='ANALYSIS_AI_MODEL'?(env('PROJECT_AI_MODEL')||env(name)):env(name)
const ai=geminiClient(assistantEnv)
Deno.serve(createProjectAssistantHandler({env,fetch},{ai,model:ai?geminiModel(assistantEnv):null}))
