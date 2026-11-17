const $ = (id) => document.getElementById(id);
const newProject = $('new-project'), dialog = $('dialog'), backdrop = $('backdrop');
const form = $('form'), input = $('name'), create = $('create'), cancel = $('cancel');
const list = $('projects'), count = $('count'), toast = $('toast');
const SWATCHES = ['#d7c4f5', '#f5d48a', '#9fd8d3', '#f3a9c4'];
let added = 0;

function show(...els) {
  els.forEach((el) => (el.hidden = false));
  requestAnimationFrame(() => requestAnimationFrame(() => els.forEach((el) => el.classList.add('open'))));
}

function hide(...els) {
  els.forEach((el) => el.classList.remove('open'));
  setTimeout(() => els.forEach((el) => (el.hidden = true)), 250);
}

function openDialog() {
  form.reset();
  create.disabled = true;
  show(backdrop, dialog);
  setTimeout(() => input.focus(), 50);
}

function closeDialog() {
  hide(backdrop, dialog);
  newProject.focus();
}

function addProject(name) {
  const li = document.createElement('li');
  li.className = 'card new';
  li.innerHTML = `<span class="swatch"></span><h2></h2><p>Edited just now</p>`;
  li.querySelector('.swatch').style.setProperty('--c', SWATCHES[added++ % SWATCHES.length]);
  li.querySelector('h2').textContent = name;
  list.prepend(li);
  count.textContent = `${list.children.length} projects`;
}

let toastTimer;
function notify(text) {
  toast.textContent = text;
  show(toast);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(toast), 2500);
}

newProject.addEventListener('click', openDialog);
cancel.addEventListener('click', closeDialog);
backdrop.addEventListener('click', closeDialog);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !dialog.hidden) closeDialog(); });
input.addEventListener('input', () => { create.disabled = input.value.trim() === ''; });

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = input.value.trim();
  if (!name) return;
  create.classList.add('busy');
  create.textContent = 'Creating…';
  setTimeout(() => {
    create.classList.remove('busy');
    create.textContent = 'Create';
    closeDialog();
    addProject(name);
    notify(`“${name}” created`);
  }, 700);
});
