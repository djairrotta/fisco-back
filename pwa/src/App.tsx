import { Outlet, Route, Routes } from "react-router-dom";
import { Logo, TabBar } from "./ui";
import Login from "./screens/Login";
import Painel from "./screens/Painel";
import Incidentes from "./screens/Incidentes";
import IncidenteDetalhe from "./screens/IncidenteDetalhe";
import Bloqueios from "./screens/Bloqueios";
import Regras from "./screens/Regras";
import Config from "./screens/Config";
import Autorizar from "./screens/Autorizar";
import Auditoria from "./screens/Auditoria";
import Codigo from "./screens/Codigo";
import Conector from "./screens/Conector";
import Ataque from "./screens/Ataque";
import Apps from "./screens/Apps";
import Servidor from "./screens/Servidor";

function Shell() {
  return (
    <>
      <header className="cabecalho">
        <Logo size={34} />
        <div>
          <div className="cabecalho__nome">Vigia</div>
          <div className="cabecalho__sub">Monitor de segurança</div>
        </div>
      </header>
      <main className="app">
        <Outlet />
      </main>
      <TabBar />
    </>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/oauth/autorizar" element={<Autorizar />} />
      <Route element={<Shell />}>
        <Route index element={<Painel />} />
        <Route path="incidentes" element={<Incidentes />} />
        <Route path="incidentes/:id" element={<IncidenteDetalhe />} />
        <Route path="bloqueios" element={<Bloqueios />} />
        <Route path="regras" element={<Regras />} />
        <Route path="auditoria" element={<Auditoria />} />
        <Route path="codigo" element={<Codigo />} />
        <Route path="conector" element={<Conector />} />
        <Route path="ataque" element={<Ataque />} />
        <Route path="apps" element={<Apps />} />
        <Route path="servidor" element={<Servidor />} />
        <Route path="config" element={<Config />} />
      </Route>
    </Routes>
  );
}
