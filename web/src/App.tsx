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
const Privacy = lazy(() => import("./pages/Privacy"));
const Terms = lazy(() => import("./pages/Terms"));
const Contact = lazy(() => import("./pages/Contact"));
const Blog = lazy(() => import("./pages/Blog"));
const Login = lazy(() => import("./pages/Auth").then((m) => ({ default: m.Login })));
const Signup = lazy(() => import("./pages/Auth").then((m) => ({ default: m.Signup })));
const Logout = lazy(() => import("./pages/Auth").then((m) => ({ default: m.Logout })));
const Pricing = lazy(() => import("./pages/Pricing"));
const Billing = lazy(() => import("./pages/Billing"));
const Exports = lazy(() => import("./pages/Exports"));
const Team = lazy(() => import("./pages/Team"));
const TeamJoin = lazy(() => import("./pages/TeamJoin"));
const BlogPost = lazy(() => import("./pages/Blog").then((m) => ({ default: m.BlogPost })));

export default function App() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/home" element={<Home />} />
        <Route path="/designs" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/logout" element={<Logout />} />
        <Route path="/editor" element={<Editor />} />
        <Route path="/upload" element={<Upload />} />
        <Route path="/preview" element={<Preview />} />
        <Route path="/preview/:designId" element={<Preview />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/billing" element={<Billing />} />
        <Route path="/exports" element={<Exports />} />
        <Route path="/team" element={<Team />} />
        <Route path="/team/join" element={<TeamJoin />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/blog" element={<Blog />} />
        <Route path="/blog/:slug" element={<BlogPost />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}
