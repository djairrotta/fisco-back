import { Navigate, Route, Routes } from "react-router-dom";
import { CaixasProvider, CHAVE_ULTIMA, useCaixas } from "./caixas";
import { armazenamento } from "./lib";
import { EsqueletoLista, ToastProvider } from "./ui";
import Moldura from "./shell/Moldura";
import Login from "./screens/Login";
import Caixas from "./screens/Caixas";
import Correio from "./screens/Correio";
import ConfigCaixa from "./screens/ConfigCaixa";
import ConfigGeral from "./screens/ConfigGeral";
import Assinaturas from "./screens/Assinaturas";
import Regras from "./screens/Regras";
import Registro from "./screens/Registro";
import ContasResend from "./screens/ContasResend";

function Shell() {
  return (
    <CaixasProvider>
      <Moldura />
    </CaixasProvider>
  );
}

/** "/" → última caixa (ou a primeira), ou a lista quando não há nenhuma. */
function Inicio() {
  const { caixas } = useCaixas();
  if (caixas === null) return <div className="correio"><section className="coluna-lista"><EsqueletoLista /></section></div>;
  if (caixas.length === 0) return <Navigate to="/caixas" replace />;
  const ultima = armazenamento.ler<number>(CHAVE_ULTIMA);
  const alvo = caixas.find((c) => c.id === ultima) ?? caixas[0];
  return <Navigate to={`/c/${alvo.id}`} replace />;
}

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Shell />}>
          <Route index element={<Inicio />} />
          <Route path="caixas" element={<Caixas />} />
          <Route path="config" element={<ConfigGeral />} />
          <Route path="registro" element={<Registro />} />
          <Route path="resend" element={<ContasResend />} />
          <Route path="c/:id/config" element={<ConfigCaixa />} />
          <Route path="c/:id/assinaturas" element={<Assinaturas />} />
          <Route path="c/:id/regras" element={<Regras />} />
          <Route path="c/:id/*" element={<Correio />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </ToastProvider>
  );
}
