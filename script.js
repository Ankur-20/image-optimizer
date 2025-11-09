// Wait for all content to be loaded
document.addEventListener('DOMContentLoaded', () => {
    // --- Global DOM Cache ---
    // Cache all the elements we'll need to interact with
    const dom = {
        dropzone: document.getElementById('dropzone'),
        fileInput: document.getElementById('file-input'),
        browseBtn: document.getElementById('browse-btn'),
        fileList: document.getElementById('file-list'),
        fileListPlaceholder: document.getElementById('file-list-placeholder'),
        fileListControls: document.getElementById('file-list-controls'),
        
        formatSelect: document.getElementById('format'),
        qualitySlider: document.getElementById('quality'),
        qualityValue: document.getElementById('quality-value'),
        widthInput: document.getElementById('width'),
        heightInput: document.getElementById('height'),
        
        processBtn: document.getElementById('process-btn'),
        processBtnText: document.getElementById('process-btn-text'),
        progressContainer: document.getElementById('progress-container'),
        progressBar: document.getElementById('progress-bar'),
        progressText: document.getElementById('progress-text'),
        
        postProcessArea: document.getElementById('post-process-area'),
        
        // NEW: Add estimated-size element
        estimatedSize: document.getElementById('estimated-size'),
        
        themeToggle: document.getElementById('theme-toggle'),
        themeSlider: document.getElementById('theme-slider'),
        themeStars: document.getElementById('theme-stars'),
        themeIconMoon: document.getElementById('theme-icon-moon'),
        themeIconSun: document.getElementById('theme-icon-sun'),
    };

    // --- Application State ---
    // This object holds the "truth" for our application
    const state = {
        pendingFiles: [], // Array of file objects { id, file, name, size, width, height, previewUrl, status }
        selectedFiles: new Set(), // A Set of file IDs that are selected
        processedFiles: [], // Array of { name, blob }
        appStatus: 'idle', // 'idle', 'processing', 'done', 'error'
        currentError: null,
        isDragActive: false,
        isJsZipLoaded: false,
        isGsapLoaded: false,
    };

    // --- GSAP Animated Elements ---
    // Store refs to elements we want to animate
    const animatedElements = {
        browseBtn: dom.browseBtn,
        processBtn: dom.processBtn,
        // These will be added when they are rendered:
        clearQueueBtn: null,
        clearCompletedBtn: null,
        downloadBtn: null,
    };
    
    // --- Helper Functions ---

    /**
     * Debounce function to limit how often a function is called.
     */
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    /**
     * Formats bytes into a human-readable string (KB, MB).
     */
    function formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    /**
     * Loads an image file to get its dimensions and a preview URL.
     */
    function getImageDimensions(file) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const previewUrl = URL.createObjectURL(file);
            
            img.onload = () => {
                resolve({ width: img.width, height: img.height, previewUrl });
            };
            img.onerror = () => {
                URL.revokeObjectURL(previewUrl); // Clean up
                reject(new Error('Could not load image'));
            };
            img.src = previewUrl;
        });
    }

    /**
     * Processes a single image file based on settings.
     */
    function processImage(file, settings) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = (e) => {
                const img = new Image();
                img.onload = async () => {
                    try {
                        const baseName = file.name.split('.').slice(0, -1).join('.') || file.name;
                        const { format, quality, width, height } = settings;
                        const mimeType = `image/${format}`;
                        
                        // "Pseudo-PNG" logic
                        let outputExtension;
                        if (format === 'webp') {
                            outputExtension = 'png'; // WebP file named .png
                        } else if (format === 'jpeg') {
                            outputExtension = 'jpg';
                        } else {
                            outputExtension = format; // 'png' remains 'png'
                        }

                        // Calculate new dimensions (maintaining aspect ratio)
                        let newWidth = img.width;
                        let newHeight = img.height;
                        const aspectRatio = img.width / img.height;

                        if (width && height) {
                            // Fit within box, maintain aspect ratio
                            const boxRatio = width / height;
                            if (aspectRatio > boxRatio) {
                                newWidth = width;
                                newHeight = Math.round(newWidth / aspectRatio);
                            } else {
                                newHeight = height;
                                newWidth = Math.round(newHeight * aspectRatio);
                            }
                        } else if (width) {
                            newWidth = width;
                            newHeight = Math.round(newWidth / aspectRatio);
                        } else if (height) {
                            newHeight = height;
                            newWidth = Math.round(newHeight * aspectRatio);
                        }
                        
                        const canvas = document.createElement('canvas');
                        canvas.width = newWidth;
                        canvas.height = newHeight;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, newWidth, newHeight);

                        const blob = await new Promise(res => {
                            if (format === 'png') {
                                canvas.toBlob(res, 'image/png'); // No quality
                            } else {
                                canvas.toBlob(res, mimeType, quality);
                            }
                        });

                        resolve({
                            name: `${baseName}.${outputExtension}`,
                            blob: blob
                        });

                    } catch (err) {
                        reject(err);
                    }
                };
                img.onerror = () => reject(new Error('Could not load image data.'));
                img.src = e.target.result;
            };
            reader.onerror = () => reject(new Error('Could not read file.'));
            reader.readAsDataURL(file);
        });
    }

    // --- State Mutators ---
    // Functions that change the state and then call render()

    /**
     * Sets the application status and re-renders.
     */
    function setAppStatus(newStatus, error = null) {
        state.appStatus = newStatus;
        state.currentError = error;
        if (newStatus !== 'processing') {
            // Reset progress if not processing
            updateProgress(0);
        }
        if (newStatus === 'idle') {
            state.processedFiles = [];
        }
        render();
    }

    /**
     * Adds new files to the pending list.
     */
    async function addFiles(files) {
        setAppStatus('idle'); // Reset on new upload
        state.processedFiles = [];
        
        for (const file of Array.from(files)) {
            if (!file.type.startsWith('image/')) continue;
            const fileId = `${file.name}-${file.size}-${file.lastModified}`;
            if (state.pendingFiles.some(pf => pf.id === fileId)) continue;
            
            try {
                const { width, height, previewUrl } = await getImageDimensions(file);
                state.pendingFiles.push({
                    id: fileId,
                    file: file,
                    name: file.name,
                    size: file.size,
                    width: width,
                    height: height,
                    previewUrl: previewUrl,
                    status: 'pending',
                });
            } catch (err) {
                console.error("Error loading image dimensions:", err);
                // Optionally add file with error state
            }
        }
        render();
        updateEstimatedSize(); // Update estimate on new files
    }

    /**
     * Removes a file from the pending list by its ID.
     */
    function removeFile(idToRemove) {
        const fileToRemove = state.pendingFiles.find(f => f.id === idToRemove);
        if (fileToRemove && fileToRemove.previewUrl) {
            URL.revokeObjectURL(fileToRemove.previewUrl);
        }
        state.pendingFiles = state.pendingFiles.filter(f => f.id !== idToRemove);
        
        // Also remove from selection
        state.selectedFiles.delete(idToRemove);
        
        if (state.pendingFiles.length === 0) {
            setAppStatus('idle');
        } else {
            render();
        }
        updateEstimatedSize(); // Update estimate on file remove
    }

    /**
     * Clears the entire file queue.
     */
    function clearQueue() {
        state.pendingFiles.forEach(file => {
            if (file.previewUrl) {
                URL.revokeObjectURL(file.previewUrl);
            }
        });
        state.pendingFiles = [];
        state.selectedFiles.clear();
        setAppStatus('idle');
        updateEstimatedSize(); // Update estimate on clear queue
    }

    /**
     * Toggles the selection state of a file.
     */
    function toggleFileSelection(id) {
        if (state.selectedFiles.has(id)) {
            state.selectedFiles.delete(id);
        } else {
            state.selectedFiles.add(id);
        }
        render();
        updateEstimatedSize(); // Update estimate on selection change
    }
    
    /**
     * Selects all 'pending' files.
     */
    function selectAll() {
        state.pendingFiles.forEach(f => {
            state.selectedFiles.add(f.id);
        });
        render();
        updateEstimatedSize(); // Update estimate on selection change
    }

    /**
     * Clears the current selection.
     */
    function clearSelection() {
        state.selectedFiles.clear();
        render();
        updateEstimatedSize(); // Update estimate on selection change
    }

    /**
     * Removes all 'done' or 'error' files from the queue.
     */
    function clearCompleted() {
        const filesToKeep = [];
        state.pendingFiles.forEach(file => {
            if (file.status === 'done' || file.status === 'error') {
                if (file.previewUrl) {
                    URL.revokeObjectURL(file.previewUrl);
                }
            } else {
                filesToKeep.push(file);
            }
        });
        state.pendingFiles = filesToKeep;
        setAppStatus('idle'); // Resets download/error state
        updateEstimatedSize(); // Update estimate
    }
    
    /**
     * Updates the progress bar visually.
     */
    function updateProgress(percentage) {
        dom.progressBar.style.width = `${percentage}%`;
        dom.progressText.textContent = `${Math.round(percentage)}%`;
    }

    // --- Render Functions ---
    // These functions update the DOM based on the current state

    /**
     * NEW: Asynchronously updates the estimated file size display.
     */
    async function updateEstimatedSize() {
        const settings = {
            format: dom.formatSelect.value,
            quality: parseFloat(dom.qualitySlider.value),
            width: dom.widthInput.value ? parseInt(dom.widthInput.value) : null,
            height: dom.heightInput.value ? parseInt(dom.heightInput.value) : null,
        };

        if (settings.format === 'png') {
            dom.estimatedSize.textContent = 'Lossless';
            dom.estimatedSize.title = 'PNG is lossless, quality slider does not apply. Size depends on resize.';
            return;
        }

        const filesToEstimate = state.selectedFiles.size > 0
            ? state.pendingFiles.filter(f => state.selectedFiles.has(f.id)) // <-- Removed "&& f.status === 'pending'"
            : state.pendingFiles.filter(f => f.status === 'pending');

        if (filesToEstimate.length === 0) {
            dom.estimatedSize.textContent = '~ 0 KB';
            dom.estimatedSize.title = 'Add files to see a size estimate.';
            return;
        }

        const sampleFile = filesToEstimate[0];
        const totalOriginalSize = filesToEstimate.reduce((acc, f) => acc + f.size, 0);

        try {
            // Use processImage to get the compressed blob of the sample file
            const { blob: estimatedBlob } = await processImage(sampleFile.file, settings);
            
            if (sampleFile.size === 0) { // Avoid divide by zero
                 dom.estimatedSize.textContent = '~ 0 KB';
                 return;
            }

            const compressionRatio = estimatedBlob.size / sampleFile.size;
            const estimatedTotalSize = totalOriginalSize * compressionRatio;

            dom.estimatedSize.textContent = `~ ${formatBytes(estimatedTotalSize)}`;
            dom.estimatedSize.title = `Estimated output size: ~${formatBytes(estimatedTotalSize)}\nOriginal size: ${formatBytes(totalOriginalSize)}`;

        } catch (err) {
            console.error("Error updating size estimate:", err);
            dom.estimatedSize.textContent = 'Error';
            dom.estimatedSize.title = 'Could not calculate estimate.';
        }
    }

    /**
     * The main render function. Calls all sub-renderers.
     */
    function render() {
        renderFileList();
        renderFileListControls();
        renderProcessButton();
        renderPostProcessArea();
        
        // Ensure all icons are created
        if (window.lucide) {
            window.lucide.createIcons();
        }
    }

    /**
     * Renders the list of file items in the queue.
     */
    function renderFileList() {
        if (state.pendingFiles.length === 0) {
            dom.fileList.innerHTML = ''; // Clear list
            dom.fileList.appendChild(dom.fileListPlaceholder);
            return;
        }
        
        dom.fileList.innerHTML = ''; // Clear list
        
        state.pendingFiles.forEach(file => {
            const isSelected = state.selectedFiles.has(file.id);
            
            const item = document.createElement('div');
            item.id = file.id;
            item.className = `flex items-center justify-between p-3 bg-gray-50/70 dark:bg-gray-700/60 rounded-lg transition-all duration-200
                                     ${file.status === 'error' ? 'bg-red-50 dark:bg-red-900/30' : ''}
                                     ${isSelected ? 'ring-2 ring-primary' : ''}
                                     cursor-pointer`;
            
            // Add click event for selection
            item.dataset.action = 'toggle-select';
            item.dataset.id = file.id;
            
            item.innerHTML = `
                <div class="flex items-center overflow-hidden">
                    <input
                        type="checkbox"
                        class="h-4 w-4 rounded border-gray-300 dark:border-gray-500 text-primary focus:ring-0 focus:ring-offset-0 disabled:opacity-50 pointer-events-none mr-3"
                        ${isSelected ? 'checked' : ''}
                    >
                    <div class="relative w-10 h-10 object-cover rounded flex-shrink-0 bg-gray-200 dark:bg-gray-600">
                        <img src="${file.previewUrl}" alt="${file.name} preview" class="w-full h-full object-cover rounded">
                        ${file.status === 'processing' ? '<div class="absolute inset-0 bg-black/50 dark:bg-black/70 flex items-center justify-center rounded"></div>' : ''}
                        ${file.status === 'done' ? '<div class="absolute inset-0 bg-secondary/30 dark:bg-secondary/50 flex items-center justify-center rounded"></div>' : ''}
                    </div>
                    <div class="ml-3 overflow-hidden">
                        <p class="text-sm font-medium text-gray-800 dark:text-gray-100 truncate" title="${file.name}">
                            ${file.name}
                        </p>
                        <p class="text-xs text-gray-500 dark:text-gray-400">
                            ${formatBytes(file.size)} | ${file.width} x ${file.height}px
                        </p>
                    </div>
                </div>
                <div class="status-icon">
                    ${renderStatusIcon(file)}
                </div>
            `;
            
            dom.fileList.appendChild(item);
        });
    }

    /**
     * Returns the HTML string for a file's status icon.
     */
    function renderStatusIcon(file) {
        switch (file.status) {
            case 'pending':
                return `
                    <button type="button" title="Remove" data-action="remove" data-id="${file.id}"
                            class="remove-file-btn flex-shrink-0 text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400 p-1">
                        <i data-lucide="x-circle" class="w-5 h-5 pointer-events-none"></i>
                    </button>`;
            case 'processing':
                return `
                    <div class="p-1" title="Processing...">
                        <i data-lucide="loader-2" class="w-5 h-5 text-primary animate-spin"></i>
                    </div>`;
            case 'done':
                return `
                    <div class="p-1" title="Completed">
                        <i data-lucide="file-check" class="w-5 h-5 text-secondary"></i>
                    </div>`;
            case 'error':
                return `
                    <button type="button" title="Remove" data-action="remove" data-id="${file.id}"
                            class="remove-file-btn flex-shrink-0 text-red-400 hover:text-red-600 p-1">
                        <i data-lucide="alert-circle" class="w-5 h-5 pointer-events-none"></i>
                    </button>`;
            default:
                return '';
        }
    }

    /**
     * Renders the controls above the file list (Select All, Clear, etc.).
     */
    function renderFileListControls() {
        const hasAny = state.pendingFiles.length > 0;
        
        let controlsHTML = '';
        
        if (hasAny) {
            controlsHTML += `
                <button type="button" title="Select All" data-action="select-all"
                        class="text-sm text-primary hover:text-primary/80 dark:text-primary/80 dark:hover:text-primary font-medium">
                    <i data-lucide="check-square" class="w-5 h-5"></i>
                </button>
                <button type="button" title="Clear Selection" data-action="clear-selection"
                        class="text-sm text-primary hover:text-primary/80 dark:text-primary/80 dark:hover:text-primary font-medium ${state.selectedFiles.size === 0 ? 'disabled:text-gray-400 cursor-not-allowed' : ''}"
                        ${state.selectedFiles.size === 0 ? 'disabled' : ''}>
                    <i data-lucide="square" class="w-5 h-5"></i>
                </button>`;
        }
        controlsHTML += `
            <button type="button" data-action="clear-queue"
                    class="text-sm text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 font-medium ${!hasAny ? 'disabled:text-gray-400 cursor-not-allowed' : ''}"
                    ${!hasAny ? 'disabled' : ''}>
                Clear All
            </button>`;
        
        dom.fileListControls.innerHTML = controlsHTML;
        
        // Add GSAP ref for clearQueueBtn if it's new
        const clearQueueBtn = dom.fileListControls.querySelector('[data-action="clear-queue"]');
        if (clearQueueBtn && !animatedElements.clearQueueBtn) {
            animatedElements.clearQueueBtn = clearQueueBtn;
            initGsapAnimation(clearQueueBtn);
        }
    }

    /**
     * Renders the main "Optimize" button text and state.
     */
    function renderProcessButton() {
        const { appStatus, selectedFiles, pendingFiles } = state;
        const isProcessing = appStatus === 'processing';
        
        // *** MODIFIED LOGIC ***
        const hasPendingFiles = pendingFiles.some(f => f.status === 'pending');
        const hasSelectedFiles = selectedFiles.size > 0;
        // We can process if there are pending files OR if files are selected (for re-processing)
        const canProcess = hasPendingFiles || hasSelectedFiles; 
        
        // Set button text
        if (isProcessing) {
            dom.processBtnText.textContent = 'Processing...';
        } else if (hasSelectedFiles) {
            dom.processBtnText.textContent = `Optimize ${selectedFiles.size} Selected`;
        } else if (hasPendingFiles) {
            const pendingCount = pendingFiles.filter(f => f.status === 'pending').length;
            dom.processBtnText.textContent = `Optimize ${pendingCount} Pending`;
        } else {
            dom.processBtnText.textContent = 'Optimize'; // Default text, will be disabled
        }

        // Show/hide progress bar vs text
        dom.progressContainer.style.opacity = isProcessing ? '1' : '0';
        dom.processBtnText.style.opacity = isProcessing ? '0' : '1';
        
        // *** MODIFIED LOGIC ***
        // Set button disabled state
        dom.processBtn.disabled = !canProcess || isProcessing;
    }

    /**
     * Renders the area below the process button (Error, Download, Clear Completed).
     */
    function renderPostProcessArea() {
        const { appStatus, currentError, processedFiles, pendingFiles } = state;
        const isProcessing = appStatus === 'processing';
        const hasCompletedFiles = pendingFiles.some(f => f.status === 'done' || f.status === 'error');
        
        let html = '';

        // Error Message
        if (appStatus === 'error' && currentError) {
            html += `
                <div class="text-red-600 dark:text-red-400 text-sm font-medium text-center">
                    <i data-lucide="alert-circle" class="w-5 h-5 inline-block mr-1.5 align-text-bottom"></i>
                    ${currentError}
                </div>`;
        }

        // "Clear Completed" Button
        if (hasCompletedFiles && !isProcessing) {
            html += `
                <button
                    type="button"
                    data-action="clear-completed"
                    class="w-full bg-gray-600 text-white font-medium py-2 px-4 rounded-lg flex items-center justify-center hover:bg-gray-700 transition-colors mt-3 text-sm"
                >
                    <i data-lucide="trash-2" class="w-4 h-4 mr-2"></i>
                    Clear Completed
                </button>`;
        }
        
        // Download Area
        if (appStatus === 'done' && processedFiles.length > 0) {
            const isZip = processedFiles.length > 1;
            const downloadName = isZip ? 'Optimized-Images.zip' : processedFiles[0].name;
            const downloadText = downloadName.length > 25 ? downloadName.substring(0, 22) + '...' : downloadName;
            
            html += `
                <div class="mt-4 text-center">
                    <p class="text-sm text-secondary dark:text-blue-300 font-medium mb-2 flex items-center justify-center">
                        <i data-lucide="file-check" class="w-5 h-5 mr-1.5"></i>
                        ${processedFiles.length} file(s) optimized!
                     </p>
                    <a
                        id="download-btn"
                        href="#" 
                        download="${downloadName}"
                        class="w-full bg-secondary text-white font-medium py-3 px-4 rounded-lg flex items-center justify-center hover:bg-secondary/90 transition-colors"
                    >
                        <i data-lucide="download" class="w-5 h-5 mr-2"></i>
                        Download ${downloadText}
                    </a>
                </div>`;
        }
        
        dom.postProcessArea.innerHTML = html;
        
        // Add GSAP refs for newly rendered buttons
        const clearCompletedBtn = dom.postProcessArea.querySelector('[data-action="clear-completed"]');
        if (clearCompletedBtn && !animatedElements.clearCompletedBtn) {
            animatedElements.clearCompletedBtn = clearCompletedBtn;
            initGsapAnimation(clearCompletedBtn);
        }
        
        const downloadBtn = dom.postProcessArea.querySelector('#download-btn');
        if (downloadBtn && !animatedElements.downloadBtn) {
            animatedElements.downloadBtn = downloadBtn;
            initGsapAnimation(downloadBtn);
        }
    }


    // --- Event Handlers ---

    /**
     * Main handler for "Optimize" button click.
     */
    async function handleProcess() {
        const filesToProcess = state.selectedFiles.size > 0
            ? state.pendingFiles.filter(f => state.selectedFiles.has(f.id) && f.status !== 'processing') // Allow re-processing 'done' files
            : state.pendingFiles.filter(f => f.status === 'pending'); // Process all pending

        if (filesToProcess.length === 0) {
            setAppStatus('error', "No files to process. Select files or clear completed.");
            return;
        }
        
        // *** NEW: Clear previous results to create a new download batch ***
        state.processedFiles = [];
        
        setAppStatus('processing');
        
        // Set status of files to 'processing'
        state.pendingFiles = state.pendingFiles.map(f => 
            filesToProcess.some(ftp => ftp.id === f.id) 
                ? { ...f, status: 'processing' } 
                : f
        );
        render(); // Show spinners
        
        const settings = {
            format: dom.formatSelect.value,
            quality: parseFloat(dom.qualitySlider.value),
            width: dom.widthInput.value ? parseInt(dom.widthInput.value) : null,
            height: dom.heightInput.value ? parseInt(dom.heightInput.value) : null,
        };

        const processedResults = [];
        const failedFiles = [];
        
        try {
            for (let i = 0; i < filesToProcess.length; i++) {
                const fileData = filesToProcess[i];
                try {
                    const result = await processImage(fileData.file, settings);
                    processedResults.push(result);
                    // Update status to 'done'
                    state.pendingFiles = state.pendingFiles.map(f => 
                        f.id === fileData.id ? { ...f, status: 'done' } : f
                    );
                } catch (err) {
                    console.error("Failed to process file:", fileData.name, err);
                    failedFiles.push(fileData.name);
                    // Update status to 'error'
                    state.pendingFiles = state.pendingFiles.map(f => 
                        f.id === fileData.id ? { ...f, status: 'error' } : f
                    );
                }
                updateProgress(((i + 1) / filesToProcess.length) * 100);
                render(); // Re-render to update status icons
            }
            
            state.processedFiles = processedResults.flat();
            state.selectedFiles.clear(); // Clear selection after processing
            
            if (failedFiles.length > 0) {
                setAppStatus('error', `Failed to process: ${failedFiles.join(', ')}`);
            } else {
                setAppStatus('done');
            }
            
        } catch (err) {
            console.error("Processing failed:", err);
            setAppStatus('error', err.message || "An unknown error occurred during processing.");
        }
    }
    
    /**
     * Handles clicks for async zip generation.
     */
    async function handleDownload(e) {
        e.preventDefault(); // Always prevent default
        
        const link = e.currentTarget;
        const isZip = state.processedFiles.length > 1;

        if (!state.isJsZipLoaded || !window.JSZip) {
            setAppStatus('error', "Zipping library is still loading. Please try again.");
            return;
        }

        // Set loading state on button
        link.innerHTML = `
            <i data-lucide="loader-2" class="w-5 h-5 mr-2 animate-spin"></i>
            ${isZip ? 'Zipping...' : 'Preparing...'}
        `;
        if (window.lucide) {
            window.lucide.createIcons(); // Re-init spinner icon
        }
        link.classList.add('opacity-75', 'cursor-wait');

        try {
            let blobUrl, downloadName;

            if (isZip) {
                const zip = new window.JSZip();
                state.processedFiles.forEach(file => {
                    zip.file(file.name, file.blob);
                });
                const zipBlob = await zip.generateAsync({
                    type: 'blob',
                    compression: 'DEFLATE',
                    compressionOptions: { level: 6 }
                });
                blobUrl = URL.createObjectURL(zipBlob);
                downloadName = 'Optimized-Images.zip';
            } else {
                // Single file
                const file = state.processedFiles[0];
                blobUrl = URL.createObjectURL(file.blob);
                downloadName = file.name;
            }

            // Create a temporary link to click
            const tempLink = document.createElement('a');
            tempLink.href = blobUrl;
            tempLink.download = downloadName;
            document.body.appendChild(tempLink);
            tempLink.click();
            
            // Clean up
            document.body.removeChild(tempLink);
            URL.revokeObjectURL(blobUrl);

            // Reset button
            const downloadText = downloadName.length > 25 ? downloadName.substring(0, 22) + '...' : downloadName;
            link.innerHTML = `
                <i data-lucide="download" class="w-5 h-5 mr-2"></i>
                Download ${downloadText}
            `;
            if (window.lucide) {
                window.lucide.createIcons();
            }
            link.classList.remove('opacity-75', 'cursor-wait');

        } catch (err) {
             setAppStatus("error", "Failed to generate download.");
             console.error("Download failed:", err);
             // Reset button (it will be re-rendered by setAppStatus)
        }
    }


    /**
     * Handles drag-and-drop state.
     */
    function handleDrag(e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === 'dragenter' || e.type === 'dragover') {
            state.isDragActive = true;
            dom.dropzone.classList.add('border-blue-600', 'bg-blue-50', 'dark:border-blue-400', 'dark:bg-gray-700');
        } else if (e.type === 'dragleave') {
            state.isDragActive = false;
            dom.dropzone.classList.remove('border-blue-600', 'bg-blue-50', 'dark:border-blue-400', 'dark:bg-gray-700');
        }
    }

    /**
     * Handles dropped files.
     */
    function handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        state.isDragActive = false;
        dom.dropzone.classList.remove('border-blue-600', 'bg-blue-50', 'dark:border-blue-400', 'dark:bg-gray-700');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            addFiles(e.dataTransfer.files);
        }
    }

    /**
     * Handles file list clicks (selection or removal).
     */
    function handleFileListClick(e) {
        const actionBtn = e.target.closest('[data-action]');
        if (!actionBtn) return;
        
        const action = actionBtn.dataset.action;
        const id = actionBtn.dataset.id;
        
        e.stopPropagation(); // Stop from bubbling
        
        if (action === 'remove') {
            removeFile(id);
        } else if (action === 'toggle-select') {
            toggleFileSelection(id);
        }
    }

    /**
     * Handles clicks on file list controls (Select All, etc.).
     */
    function handleFileControlsClick(e) {
        const actionBtn = e.target.closest('[data-action]');
        if (!actionBtn) return;
        
        const action = actionBtn.dataset.action;
        
        switch (action) {
            case 'select-all':
                selectAll();
                break;
            case 'clear-selection':
                clearSelection();
                break;
            case 'clear-queue':
                clearQueue();
                break;
        }
    }

    /**
     * Handles clicks in the post-process area (Download, Clear Completed).
     */
    function handlePostProcessAction(e) {
        const downloadBtn = e.target.closest('#download-btn');
        if (downloadBtn) {
            handleDownload(e);
            return;
        }

        const clearBtn = e.target.closest('[data-action="clear-completed"]');
        if (clearBtn) {
            clearCompleted();
            return;
        }
    }

    // --- Theme Toggle Logic ---
    
    function handleThemeToggle() {
        const isDark = document.documentElement.classList.toggle('dark');
        document.documentElement.classList.toggle('light', !isDark);
        
        const theme = isDark ? 'dark' : 'light';
        localStorage.setItem('theme', theme);
        
        updateThemeToggleState(theme);
    }
    
    function updateThemeToggleState(theme) {
        const isDark = (theme === 'dark');
        
        dom.themeToggle.setAttribute('aria-checked', isDark);
        dom.themeToggle.setAttribute('title', isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode');
        
        // Toggle BG color
        dom.themeToggle.classList.toggle('bg-indigo-900', isDark);
        dom.themeToggle.classList.toggle('bg-sky-400', !isDark);

        // Show/hide stars
        dom.themeStars.classList.toggle('opacity-100', isDark);
        dom.themeStars.classList.toggle('opacity-0', !isDark);
        
        // Slide handle
        dom.themeSlider.classList.toggle('translate-x-5', isDark);
        dom.themeSlider.classList.toggle('translate-x-0', !isDark);
        dom.themeSlider.classList.toggle('bg-gray-200', isDark);
        dom.themeSlider.classList.toggle('bg-yellow-400', !isDark);
        
        // Toggle icons
        dom.themeIconMoon.classList.toggle('opacity-100', isDark);
        dom.themeIconMoon.classList.toggle('opacity-0', !isDark);
        dom.themeIconSun.classList.toggle('opacity-100', !isDark);
        dom.themeIconSun.classList.toggle('opacity-0', isDark);
    }
    
    // --- GSAP Animation ---
    
    function initGsapAnimation(button) {
        if (!button || !window.gsap) return;
        
        window.gsap.set(button, { transformOrigin: 'center center' });
        
        button.addEventListener('mouseenter', () => {
            window.gsap.to(button, { 
                scale: 1.05, 
                y: -2,
                duration: 0.2, 
                ease: 'power1.out'
            });
        });
        
        button.addEventListener('mouseleave', () => {
            window.gsap.to(button, { 
                scale: 1, 
                y: 0, 
                duration: 0.2, 
                ease: 'power1.out' 
            });
        });
        
        // --- REMOVED STRAY CODE FROM HERE ---
    }

    // --- Initialization ---
    const initialize = () => {
        // --- Load Libraries ---
        if (window.JSZip) state.isJsZipLoaded = true;
        if (window.gsap) {
            state.isGsapLoaded = true;
            // Init animations for buttons that exist on load
            initGsapAnimation(animatedElements.browseBtn);
            initGsapAnimation(animatedElements.processBtn);
        }
    
        // --- Set initial theme state ---
        const currentTheme = localStorage.getItem('theme') || 'light';
        updateThemeToggleState(currentTheme);
        
        // --- Create debounced version of the size estimator ---
        const debouncedUpdateEstimatedSize = debounce(updateEstimatedSize, 250);

        // --- Event Listeners ---
        dom.browseBtn.addEventListener('click', () => {
            dom.fileInput.value = null; // <-- THE FIX
            dom.fileInput.click();
        });
        dom.fileInput.addEventListener('change', (e) => addFiles(e.target.files));
        
        // Dropzone events
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dom.dropzone.addEventListener(eventName, handleDrag, false);
        });
        dom.dropzone.addEventListener('drop', handleDrop);

        // File list clicks
        dom.fileList.addEventListener('click', handleFileListClick);
        
        // File list controls
        dom.fileListControls.addEventListener('click', handleFileControlsClick);
        
        // Settings
        dom.qualitySlider.addEventListener('input', (e) => {
            dom.qualityValue.textContent = parseFloat(e.target.value).toFixed(2);
            debouncedUpdateEstimatedSize(); // Update estimate on slide
        });
        dom.formatSelect.addEventListener('change', () => {
            const isPNG = dom.formatSelect.value === 'png';
            dom.qualitySlider.disabled = isPNG;
            dom.qualityValue.textContent = isPNG ? 'N/A' : parseFloat(dom.qualitySlider.value).toFixed(2);
            dom.qualitySlider.style.opacity = isPNG ? 0.5 : 1;
            debouncedUpdateEstimatedSize(); // Update estimate on format change
        });
        
        // NEW: Listen to resize inputs for estimation
        dom.widthInput.addEventListener('input', debouncedUpdateEstimatedSize);
        dom.heightInput.addEventListener('input', debouncedUpdateEstimatedSize);

        // Main action button
        dom.processBtn.addEventListener('click', handleProcess);
        
        // Post-process area
        dom.postProcessArea.addEventListener('click', handlePostProcessAction);
        
        // Theme toggle
        dom.themeToggle.addEventListener('click', handleThemeToggle);
        
        // --- Initial Render ---
        render();
        updateEstimatedSize(); // Run initial estimate on load
    };

    // Run the app!
    initialize();
});
