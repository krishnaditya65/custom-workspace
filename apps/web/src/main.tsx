/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import "./app.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error(
    "Root element #root not found - check index.html has <div id=\"root\"></div>.",
  );
}

render(() => <App />, root);
