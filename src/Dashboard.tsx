import { AuthGate } from './components/AuthGate'
import { WorkspaceShell } from './components/WorkspaceShell'
export default function Dashboard(){return <AuthGate><WorkspaceShell/></AuthGate>}
