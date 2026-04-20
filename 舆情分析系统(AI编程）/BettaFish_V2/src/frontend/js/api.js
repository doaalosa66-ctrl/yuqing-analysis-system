(function () {
    'use strict';

    var API_BASE = '';

    function _json(method, url, body) {
        var opts = {
            method: method,
            headers: { 'Content-Type': 'application/json' },
        };
        if (body !== undefined) {
            opts.body = JSON.stringify(body);
        }
        return fetch(API_BASE + url, opts).then(function (r) {
            if (!r.ok) {
                var err = new Error('HTTP ' + r.status);
                err.status = r.status;
                throw err;
            }
            return r.json();
        });
    }

    function startSearch(query, opts) {
        opts = opts || {};
        var payload = { query: query };
        if (opts.forceRefresh) payload.force_refresh = true;
        return _json('POST', '/api/search', payload);
    }

    function getSearchStatus(taskId) {
        return _json('GET', '/api/search/status/' + taskId);
    }

    function getReportResult(taskId) {
        return fetch(API_BASE + '/api/report/result/' + taskId).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.text();
        });
    }

    function getReportHistory() {
        return _json('GET', '/api/report/history');
    }

    function getReportStatus() {
        return _json('GET', '/api/report/status');
    }

    function generateReport(query, customTemplate) {
        var payload = { query: query };
        if (customTemplate) payload.custom_template = customTemplate;
        return _json('POST', '/api/report/generate', payload);
    }

    function getReportProgress(taskId) {
        return _json('GET', '/api/report/progress/' + taskId);
    }

    function exportPdf(taskId, optimize) {
        var url = '/api/report/export/pdf/' + taskId;
        if (optimize) url += '?optimize=true';
        return fetch(API_BASE + url).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r;
        });
    }

    function exportMd(taskId) {
        return fetch(API_BASE + '/api/report/export/md/' + taskId).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r;
        });
    }

    function downloadReport(taskId) {
        return fetch(API_BASE + '/api/report/download/' + taskId).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r;
        });
    }

    function getConfig() {
        return _json('GET', '/api/config');
    }

    function saveConfig(data) {
        return _json('POST', '/api/config', data);
    }

    function getSystemStatus() {
        return _json('GET', '/api/system/status');
    }

    function startSystem() {
        return _json('POST', '/api/system/start');
    }

    function shutdownSystem() {
        return _json('POST', '/api/system/shutdown');
    }

    function getOutput(appName) {
        return _json('GET', '/api/output/' + appName);
    }

    function startApp(appName) {
        return _json('POST', '/api/start/' + appName);
    }

    function stopApp(appName) {
        return _json('POST', '/api/stop/' + appName);
    }

    function getForumLog() {
        return _json('GET', '/api/forum/log');
    }

    function getForumLogHistory(params) {
        return _json('POST', '/api/forum/log/history', params || {});
    }

    function startForum() {
        return _json('POST', '/api/forum/start');
    }

    function stopForum() {
        return _json('POST', '/api/forum/stop');
    }

    window.API = {
        startSearch: startSearch,
        getSearchStatus: getSearchStatus,
        getReportResult: getReportResult,
        getReportHistory: getReportHistory,
        getReportStatus: getReportStatus,
        generateReport: generateReport,
        getReportProgress: getReportProgress,
        exportPdf: exportPdf,
        exportMd: exportMd,
        downloadReport: downloadReport,
        getConfig: getConfig,
        saveConfig: saveConfig,
        getSystemStatus: getSystemStatus,
        startSystem: startSystem,
        shutdownSystem: shutdownSystem,
        getOutput: getOutput,
        startApp: startApp,
        stopApp: stopApp,
        getForumLog: getForumLog,
        getForumLogHistory: getForumLogHistory,
        startForum: startForum,
        stopForum: stopForum,
    };
})();
