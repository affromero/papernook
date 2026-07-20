export function captureBookmarklet(baseUrl: string, token: string): string {
  const action = `${baseUrl.replace(/\/+$/, "")}/add`;
  return `javascript:(()=>{const f=document.createElement('form');f.method='POST';f.action=${JSON.stringify(action)};for(const[k,v]of Object.entries({token:${JSON.stringify(token)},url:location.href})){const i=document.createElement('input');i.type='hidden';i.name=k;i.value=v;f.append(i)}document.body.append(f);f.submit()})()`;
}

export function submitCapture(
  action: string,
  token: string,
  url: string,
): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = action;
  for (const [name, value] of Object.entries({ token, url })) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
}
