const form = document.getElementById("form");

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const file = document.getElementById("audio").files[0];
  if (!file) {
    alert("Please choose an audio file.");
    return;
  }

  const data = new FormData();
  data.append("audio", file);

  document.getElementById("transcript").textContent = "Processing...";
  document.getElementById("article").textContent = "Processing...";

  try {
    const res = await fetch("/api/sermon-to-article", {
      method: "POST",
      body: data
    });

    const result = await res.json();

    if (!res.ok) {
      throw new Error(result.error || "Request failed");
    }

    document.getElementById("transcript").textContent = result.transcript || "";
    document.getElementById("article").textContent = result.article || "";
  } catch (error) {
    document.getElementById("transcript").textContent = "Error";
    document.getElementById("article").textContent = error.message;
  }
});