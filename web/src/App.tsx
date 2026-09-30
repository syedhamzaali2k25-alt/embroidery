import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";

// Each screen is its own chunk so it loads only its own stylesheet, as the static pages did
// (landing.css has global h1/h2/main rules that must not reach the other screens).
const Landing = lazy(() => import("./pages/Landing"));
const Home = lazy(() => import("./pages/Home"));
const Editor = lazy(() => import("./pages/Editor"));
const Upload = lazy(() => import("./pages/Upload"));
const Preview = lazy(() => import("./pages/Preview"));
const NotFound = lazy(() => import("./pages/NotFound"));

export default function App() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/home" element={<Home />} />
        <Route path="/editor" element={<Editor />} />
        <Route path="/upload" element={<Upload />} />
        <Route path="/preview" element={<Preview />} />
        <Route path="/preview/:designId" element={<Preview />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
