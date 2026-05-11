const { Plugin, Notice } = require('obsidian');

module.exports = class InboxZero extends Plugin {
  async onload() {
    console.log('[Inbox Zero] Загружен');

    // Загружаем сохранённые данные (порядок списков)
    this.data = await this.loadData() || { orders: {} };

    this.registerMarkdownCodeBlockProcessor(
      'inbox-zero',
      this._processInboxZeroBlock.bind(this)
    );
  }

  onunload() {
    console.log('[Inbox Zero] Выгружен');
  }

  /**
   * Обработка кодового блока ```inbox-zero
   */
  async _processInboxZeroBlock(source, el, ctx) {
    const config = this._parseConfig(source);
    if (!config) {
      el.createDiv({ text: 'Ошибка: не удалось прочитать конфигурацию блока.' });
      return;
    }

    if (!config.tag) {
      el.createDiv({ text: 'Ошибка: не указан тег для поиска (tag: имя_тега).' });
      return;
    }

    const folders = config.folders || [];
    if (folders.length === 0) {
      el.createDiv({ text: 'Ошибка: не указаны папки для мониторинга (folders: [...]).' });
      return;
    }

    const recursive = config.recursive !== undefined ? config.recursive : true;
    const container = el.createDiv({ cls: 'inbox-zero-container' });

    // Уникальный ключ для этого блока: путь заметки + тег
    const blockKey = ctx.sourcePath + '::' + config.tag;

    // Функция сохранения текущего порядка (из DOM) в data.json
    const saveOrder = async () => {
      const order = this._collectOrderFromDOM(container);
      if (!this.data.orders) this.data.orders = {};
      this.data.orders[blockKey] = order;
      await this.saveData(this.data);
    };

    // Основная функция рендера списка
    const renderList = async (preserveOrder = true) => {
      container.empty();

      const allFiles = this.app.vault.getMarkdownFiles();

      // Фильтрация по папкам
      const filesInFolders = allFiles.filter((file) => {
        const filePath = file.path;
        return folders.some((folder) => {
          const normalizedFolder = folder.endsWith('/') ? folder : folder + '/';
          if (recursive) {
            return filePath.startsWith(normalizedFolder);
          } else {
            const parent = file.parent?.path + '/';
            return parent === normalizedFolder;
          }
        });
      });

      const tagToFind = '#' + config.tag;
      const filesWithTag = [];

      for (const file of filesInFolders) {
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache) continue;

        // Собираем только inline-теги (#тег прямо в тексте)
        let tags = [];
        if (cache.tags) {
          tags.push(...cache.tags.map(t => t.tag));
        }

        // Нормализуем: убираем пробелы, приводим к нижнему регистру, добавляем # если нет
        const normalizedTags = tags.map((t) => {
          let tagStr = String(t).trim();
          if (!tagStr.startsWith('#')) tagStr = '#' + tagStr;
          return tagStr.toLowerCase();
        });

        if (normalizedTags.includes(tagToFind.toLowerCase())) {
          filesWithTag.push(file);
        }
      }

      if (filesWithTag.length === 0) {
        container.createDiv({ 
          text: 'Нет файлов с этим тегом в указанных папках.',
          cls: 'empty-message'
        });
        return;
      }

      // Сортировка с учётом сохранённого порядка
      let sortedFiles;
      const savedOrder = this.data.orders?.[blockKey] || [];
      if (preserveOrder && savedOrder.length > 0) {
        // Создаём Map для быстрого доступа
        const fileMap = new Map(filesWithTag.map(f => [f.path, f]));
        // Сначала идут файлы в сохранённом порядке (если они ещё существуют)
        const ordered = savedOrder
          .map(path => fileMap.get(path))
          .filter(f => f); // убираем undefined (удалённые файлы)
        // Добавляем новые файлы, которых нет в сохранённом порядке, в конец по алфавиту
        const savedSet = new Set(savedOrder);
        const newFiles = filesWithTag
          .filter(f => !savedSet.has(f.path))
          .sort((a, b) => a.basename.localeCompare(b.basename));
        sortedFiles = [...ordered, ...newFiles];
      } else {
        // По умолчанию — алфавит
        sortedFiles = [...filesWithTag].sort((a, b) => a.basename.localeCompare(b.basename));
      }

      const list = container.createEl('ul', { cls: 'inbox-zero-list' });

      for (const file of sortedFiles) {
        const listItem = list.createEl('li', { cls: 'inbox-zero-item' });
        listItem.setAttribute('draggable', 'true');

        const checkbox = listItem.createEl('input', {
          type: 'checkbox',
          cls: 'inbox-zero-checkbox',
        });
        checkbox.dataset.filePath = file.path;

        const link = listItem.createEl('a', {
          text: file.basename,
          cls: 'inbox-zero-link',
          href: '#',
        });
        link.addEventListener('click', (e) => {
          e.preventDefault();
          this.app.workspace.openLinkText(file.path, '', false);
        });

        // Drag-and-drop события
        listItem.addEventListener('dragstart', (e) => {
          // Запрещаем перетаскивание, если тянут за чекбокс
          if (e.target.tagName === 'INPUT') {
            e.preventDefault();
            return false;
          }
          e.dataTransfer.setData('text/plain', file.path);
          e.dataTransfer.effectAllowed = 'move';
          listItem.classList.add('dragging');
        });

        listItem.addEventListener('dragend', () => {
          listItem.classList.remove('dragging');
          // Снимаем подсветку со всех элементов
          list.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        });

        listItem.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const draggingItem = list.querySelector('.dragging');
          if (draggingItem && draggingItem !== listItem) {
            listItem.classList.add('drag-over');
          }
        });

        listItem.addEventListener('dragleave', () => {
          listItem.classList.remove('drag-over');
        });

        listItem.addEventListener('drop', async (e) => {
          e.preventDefault();
          listItem.classList.remove('drag-over');
          const draggingItem = list.querySelector('.dragging');
          if (!draggingItem || draggingItem === listItem) return;

          // Перемещаем элемент в DOM
          const items = [...list.children];
          const fromIndex = items.indexOf(draggingItem);
          const toIndex = items.indexOf(listItem);
          if (fromIndex < toIndex) {
            list.insertBefore(draggingItem, listItem.nextSibling);
          } else {
            list.insertBefore(draggingItem, listItem);
          }

          // Сохраняем новый порядок
          await saveOrder();
        });

        // Обработчик чекбокса (удаление)
        checkbox.addEventListener('change', async (event) => {
          if (!checkbox.checked) return;
          try {
            await this.app.vault.delete(file);
            console.log(`[Inbox Zero] Удалён файл: ${file.path}`);
            new Notice(`Файл "${file.basename}" удалён безвозвратно.`);
            listItem.remove();
            // Сохраняем обновлённый порядок
            await saveOrder();
            if (list.children.length === 0) {
              container.empty();
              container.createDiv({ 
                text: 'Все файлы обработаны. Ничего не осталось.',
                cls: 'empty-message'
              });
            }
          } catch (error) {
            console.error('[Inbox Zero] Ошибка удаления:', error);
            new Notice('Не удалось удалить файл.');
            checkbox.checked = false;
          }
        });
      }
    };

    // Первичный рендер
    await renderList();

    // Обработчики изменений для автообновления
    const updateHandler = () => {
      if (container.isConnected) {
        renderList(true); // preserveOrder = true, чтобы не сбросить порядок
      }
    };

    this.registerEvent(this.app.metadataCache.on('resolved', updateHandler));
    this.registerEvent(this.app.vault.on('create', updateHandler));
    this.registerEvent(this.app.vault.on('delete', updateHandler));
    this.registerEvent(this.app.metadataCache.on('changed', updateHandler));
  }

  /**
   * Собирает массив путей файлов в том порядке, как они сейчас в DOM.
   */
  _collectOrderFromDOM(container) {
    const checkboxes = container.querySelectorAll('.inbox-zero-checkbox');
    const order = [];
    checkboxes.forEach(cb => {
      if (cb.dataset.filePath) {
        order.push(cb.dataset.filePath);
      }
    });
    return order;
  }

  /**
   * Парсит конфигурацию из текста блока (без изменений)
   */
  _parseConfig(source) {
    const config = {};
    const lines = source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const key = line.slice(0, colonIndex).trim().toLowerCase();
      let value = line.slice(colonIndex + 1).trim();

      if (key === 'folders') {
        try {
          const jsonStr = value.replace(/'/g, '"');
          config.folders = JSON.parse(jsonStr);
        } catch (e) {
          const cleaned = value.replace(/[\[\]'"]/g, '');
          config.folders = cleaned
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        }
      } else if (key === 'recursive') {
        config.recursive = value.toLowerCase() === 'true' || value === '1';
      } else if (key === 'tag') {
        config.tag = value.replace(/['"]/g, '');
      }
    }

    return config;
  }
};