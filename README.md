# IBGE_Maps_SVG
Mapas usando API do IBGE para SVG

## Páginas

- `index.html` — editor de mapas em SVG (estados e municípios, pintura, exportação SVG).
- `mapa3d.html` — mapa do Brasil em 3D (estados extrudados) para tirar fotos em perspectiva:
  - gire, aproxime e incline a câmera livremente (ou use os atalhos de câmera);
  - destaque estados com cor e altura próprias (clique no mapa ou escolha na lista);
  - adicione marcadores por município (busca na API do IBGE) ou clicando no mapa, com título, subtítulo e ícone;
  - ligue marcadores com setas curvas; o texto automático é a distância em linha reta (`~350 km`) e pode ser trocado;
  - exporte PNG em vários tamanhos (até 4K), com fundo transparente opcional.

As malhas e localidades vêm da API de serviços de dados do IBGE (`servicodados.ibge.gov.br`), e o 3D usa Three.js via CDN, então as páginas precisam de internet. A cena 3D fica salva no navegador (localStorage).

Para rodar localmente, sirva a pasta com qualquer servidor estático (por exemplo `npx serve .`) e abra `mapa3d.html`; abrir o arquivo direto (`file://`) não carrega os módulos JavaScript.
