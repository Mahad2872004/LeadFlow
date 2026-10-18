import App from './App'
import { AuthGate } from './components/AuthGate'
export default function Dashboard(){return <AuthGate><App/></AuthGate>}
