import { createOutreachHandler } from './handler.ts'
import { geminiClient, geminiModel } from '../_shared/analysis/gemini.ts'
const env=(name:string)=>Deno.env.get(name)
// Drafts use OUTREACH_AI_MODEL when it is set, otherwise the business analysis model (ANALYSIS_AI_MODEL or the default).
const outreachEnv=(name:string)=>name==='ANALYSIS_AI_MODEL'?(env('OUTREACH_AI_MODEL')||env(name)):env(name)
const ai=geminiClient(outreachEnv)
Deno.serve(createOutreachHandler({env,fetch},{ai,model:ai?geminiModel(outreachEnv):null}))
