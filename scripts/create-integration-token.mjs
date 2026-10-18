import { randomBytes, createHash } from 'node:crypto'
const token='lf_'+randomBytes(32).toString('hex')
console.log('Store this token only in your server or automation credential store. Do not commit it or use it in browser code.')
console.log(JSON.stringify({token,tokenHash:createHash('sha256').update(token).digest('hex')},null,2))
