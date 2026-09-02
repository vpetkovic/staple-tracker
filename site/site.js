document.querySelectorAll(".copy").forEach((button) => {
  button.addEventListener("click", async () => {
    const code = button.parentElement.querySelector("code").textContent;
    await navigator.clipboard.writeText(code);
    button.textContent = "copied";
    window.setTimeout(() => { button.textContent = "copy"; }, 1400);
  });
});
