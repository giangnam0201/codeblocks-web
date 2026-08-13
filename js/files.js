/* ---------------------------------------------------------------------------
   files.js - real files on the user's disk.

   Chrome's File System Access API gives us the same dialogs the desktop IDE
   shows, and a handle we can keep: after the first save, Ctrl-S writes
   straight back to the file with no dialog, exactly like Code::Blocks.

   Browsers without the API fall back to <input type=file> for opening and a
   download for saving, which is the closest equivalent available.
--------------------------------------------------------------------------- */
'use strict';

const Disk = {
    supported: typeof window.showOpenFilePicker === 'function',
    lastDir: undefined,      // a FileSystemDirectoryHandle, used to reopen in place
};

const SOURCE_TYPES = [{
    description: 'C/C++ source files',
    accept: {
        'text/x-c++src': ['.cpp', '.cxx', '.cc', '.c++'],
        'text/x-csrc': ['.c'],
        'text/x-chdr': ['.h', '.hpp', '.hxx', '.hh'],
    },
}];

const PROJECT_TYPES = [{
    description: 'Code::Blocks project files',
    accept: { 'application/xml': ['.cbp'] },
}];

/* --------------------------------------------------------------- opening */

/* Shows the real Open dialog.  Returns [{name, text, handle}]. */
Disk.open = async function (multiple) {
    if (Disk.supported) {
        let handles;
        try {
            handles = await window.showOpenFilePicker({
                multiple: multiple !== false,
                startIn: Disk.lastDir || 'documents',
                types: SOURCE_TYPES.concat(PROJECT_TYPES),
                excludeAcceptAllOption: false,
            });
        } catch (e) {
            return [];                               // the user pressed Cancel
        }
        const out = [];
        for (const h of handles) {
            const f = await h.getFile();
            out.push({ name: h.name, text: await f.text(), handle: h });
        }
        return out;
    }
    return Disk.openLegacy(multiple);
};

Disk.openLegacy = function (multiple) {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = multiple !== false;
        input.accept = '.c,.cpp,.cc,.cxx,.h,.hpp,.hh,.hxx,.cbp,.txt';
        input.addEventListener('change', async () => {
            const out = [];
            for (const f of Array.from(input.files)) out.push({ name: f.name, text: await f.text(), handle: null });
            resolve(out);
        });
        input.addEventListener('cancel', () => resolve([]));
        input.click();
    });
};

/* --------------------------------------------------------------- writing */

/* Writes through an existing handle - no dialog. */
Disk.writeHandle = async function (handle, text) {
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
};

/* Shows the real Save-as dialog and returns the new handle, or null. */
Disk.saveAs = async function (suggestedName, text) {
    if (Disk.supported) {
        let handle;
        try {
            handle = await window.showSaveFilePicker({
                suggestedName,
                startIn: Disk.lastDir || 'documents',
                types: SOURCE_TYPES,
            });
        } catch (e) {
            return null;                             // cancelled
        }
        await Disk.writeHandle(handle, text);
        return handle;
    }
    Disk.download(suggestedName, text);
    return null;
};

Disk.download = function (name, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
};

/* Saves a file: silent when we already own a handle, dialog otherwise. */
Disk.save = async function (file) {
    const text = file.text();
    if (file.handle) {
        try {
            await Disk.writeHandle(file.handle, text);
            return true;
        } catch (e) {
            // the handle went stale (file moved/permission revoked): re-ask
            file.handle = null;
        }
    }
    const handle = await Disk.saveAs(file.name, text);
    if (handle) {
        file.handle = handle;
        file.name = handle.name;
        return true;
    }
    return !Disk.supported;   // the legacy path already downloaded the file
};

/* ------------------------------------------------------- project folders */

/* Asks for a folder, so a new project can really be created on disk. */
Disk.pickDirectory = async function () {
    if (!window.showDirectoryPicker) return null;
    try {
        const dir = await window.showDirectoryPicker({ mode: 'readwrite', startIn: Disk.lastDir || 'documents' });
        Disk.lastDir = dir;
        return dir;
    } catch (e) {
        return null;
    }
};

/* Creates (or overwrites) a file inside a directory handle. */
Disk.createIn = async function (dirHandle, name, text) {
    const h = await dirHandle.getFileHandle(name, { create: true });
    await Disk.writeHandle(h, text);
    return h;
};
