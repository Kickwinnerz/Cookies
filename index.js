// save as index.js
// npm install express ws axios fca-mafiya uuid

const fs = require('fs');
const express = require('express');
const wiegine = require('fca-mafiya');
const WebSocket = require('ws');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 20428;

// Store active tasks - Persistent storage simulation
const TASKS_FILE = 'active_tasks.json';
const COOKIES_DIR = 'cookies';

// Ensure directories exist
if (!fs.existsSync(COOKIES_DIR)) {
    fs.mkdirSync(COOKIES_DIR, { recursive: true });
}

// Load persistent tasks
function loadTasks() {
    try {
        if (fs.existsSync(TASKS_FILE)) {
            const data = fs.readFileSync(TASKS_FILE, 'utf8');
            const tasksData = JSON.parse(data);
            const tasks = new Map();

            for (let [taskId, taskData] of Object.entries(tasksData)) {
                const task = new Task(taskId, taskData.userData);
                task.config = taskData.config;
                task.messageData = taskData.messageData;
                task.stats = taskData.stats;
                task.logs = taskData.logs || [];
                task.config.running = true; // Auto-restart
                tasks.set(taskId, task);

                console.log(`🔥 Reloaded persistent task: ${taskId}`);

                // Auto-restart the task
                setTimeout(() => {
                    if (task.config.running) {
                        task.start();
                    }
                }, 5000);
            }

            return tasks;
        }
    } catch (error) {
        console.error('Error loading tasks:', error);
    }
    return new Map();
}

// Save tasks persistently
function saveTasks() {
    try {
        const tasksData = {};
        for (let [taskId, task] of activeTasks.entries()) {
            if (task.config.running) { // Only save running tasks
                tasksData[taskId] = {
                    userData: task.userData,
                    config: { ...task.config, api: null }, // Remove api reference
                    messageData: task.messageData,
                    stats: task.stats,
                    logs: task.logs.slice(0, 50) // Keep recent logs only
                };
            }
        }
        fs.writeFileSync(TASKS_FILE, JSON.stringify(tasksData, null, 2));
    } catch (error) {
        console.error('Error saving tasks:', error);
    }
}

// Auto-save tasks every 30 seconds
setInterval(saveTasks, 30000);

// Auto-restart mechanism
function setupAutoRestart() {
    // Check every minute for stuck tasks
    setInterval(() => {
        for (let [taskId, task] of activeTasks.entries()) {
            if (task.config.running && !task.healthCheck()) {
                console.log(`🔥 Auto-restarting stuck task: ${taskId}`);
                task.restart();
            }
        }
    }, 60000);
}

let activeTasks = loadTasks();

// Enhanced Task management class with auto-recovery
class Task {
    constructor(taskId, userData) {
        this.taskId = taskId;
        this.userData = userData;
        this.config = {
            prefix: '',
            delay: userData.delay || 5,
            running: false,
            api: null,
            repeat: true,
            lastActivity: Date.now(),
            restartCount: 0,
            maxRestarts: 1000 // Unlimited restarts essentially
        };
        this.messageData = {
            threadID: userData.threadID,
            messages: [],
            currentIndex: 0,
            loopCount: 0
        };
        this.stats = {
            sent: 0,
            failed: 0,
            activeCookies: 0,
            loops: 0,
            restarts: 0,
            lastSuccess: null
        };
        this.logs = [];
        this.retryCount = 0;
        this.maxRetries = 50;
        this.initializeMessages(userData.messageContent, userData.hatersName, userData.lastHereName);
    }

    initializeMessages(messageContent, hatersName, lastHereName) {
        this.messageData.messages = messageContent
            .split('\n')
            .map(line => line.replace(/\r/g, '').trim())
            .filter(line => line.length > 0)
            .map(message => `${hatersName} ${message} ${lastHereName}`);

        this.addLog(`Loaded ${this.messageData.messages.length} formatted messages`);
    }

    addLog(message, messageType = 'info') {
        const logEntry = {
            time: new Date().toLocaleTimeString('en-IN'),
            message: message,
            type: messageType
        };
        this.logs.unshift(logEntry);
        if (this.logs.length > 100) {
            this.logs = this.logs.slice(0, 100);
        }

        this.config.lastActivity = Date.now();
        broadcastToTask(this.taskId, {
            type: 'log',
            message: message,
            messageType: messageType
        });
    }

    healthCheck() {
        // If no activity for 5 minutes, consider stuck
        return Date.now() - this.config.lastActivity < 300000;
    }

    async start() {
        if (this.config.running) {
            this.addLog('Task is already running', 'info');
            return true;
        }

        this.config.running = true;
        this.retryCount = 0;

        try {
            const cookiePath = `${COOKIES_DIR}/cookie_${this.taskId}.txt`;
            fs.writeFileSync(cookiePath, this.userData.cookieContent);
            this.addLog('Cookie content saved', 'success');
        } catch (err) {
            this.addLog(`Failed to save cookie: ${err.message}`, 'error');
            this.config.running = false;
            return false;
        }

        if (this.messageData.messages.length === 0) {
            this.addLog('No messages found in the file', 'error');
            this.config.running = false;
            return false;
        }

        this.addLog(`Starting task with ${this.messageData.messages.length} messages`);

        return this.initializeBot();
    }

    initializeBot() {
        return new Promise((resolve) => {
            wiegine.login(this.userData.cookieContent, { 
                logLevel: "silent",
                forceLogin: true,
                selfListen: false
            }, (err, api) => {
                if (err || !api) {
                    this.addLog(`Login failed: ${err ? err.message : 'Unknown error'}`, 'error');

                    // Auto-retry login
                    if (this.retryCount < this.maxRetries) {
                        this.retryCount++;
                        this.addLog(`Auto-retry login attempt ${this.retryCount}/${this.maxRetries} in 30 seconds...`, 'info');

                        setTimeout(() => {
                            this.initializeBot();
                        }, 30000);
                    } else {
                        this.addLog('Max login retries reached. Task paused.', 'error');
                        this.config.running = false;
                    }

                    resolve(false);
                    return;
                }

                this.config.api = api;
                this.stats.activeCookies = 1;
                this.retryCount = 0;
                this.addLog('Logged in successfully', 'success');

                // Enhanced error handling for API
                this.setupApiErrorHandling(api);

                this.getGroupInfo(api, this.messageData.threadID);

                this.sendNextMessage(api);
                resolve(true);
            });
        });
    }

    setupApiErrorHandling(api) {
        // Handle various API errors gracefully
        if (api && typeof api.listen === 'function') {
            try {
                api.listen((err, event) => {
                    if (err) {
                        // Silent error handling - no user disruption
                        console.log(`🔥 Silent API error handled for task ${this.taskId}`);
                    }
                });
            } catch (e) {
                // Silent catch - no disruption
            }
        }
    }

    getGroupInfo(api, threadID) {
        try {
            if (api && typeof api.getThreadInfo === 'function') {
                api.getThreadInfo(threadID, (err, info) => {
                    if (!err && info) {
                        this.addLog(`Target: ${info.name || 'Unknown'} (ID: ${threadID})`, 'info');
                    }
                });
            }
        } catch (e) {
            // Silent error - group info not critical
        }
    }

    sendNextMessage(api) {
        if (!this.config.running || !api) {
            return;
        }

        // Message loop management
        if (this.messageData.currentIndex >= this.messageData.messages.length) {
            this.messageData.loopCount++;
            this.stats.loops = this.messageData.loopCount;
            this.addLog(`Loop #${this.messageData.loopCount} completed. Restarting.`, 'info');
            this.messageData.currentIndex = 0;
        }

        const message = this.messageData.messages[this.messageData.currentIndex];
        const currentIndex = this.messageData.currentIndex;
        const totalMessages = this.messageData.messages.length;

        // Enhanced send with multiple fallbacks
        this.sendMessageWithRetry(api, message, currentIndex, totalMessages);
    }

    sendMessageWithRetry(api, message, currentIndex, totalMessages, retryAttempt = 0) {
        if (!this.config.running) return;

        const maxSendRetries = 10;

        try {
            api.sendMessage(message, this.messageData.threadID, (err) => {
                const timestamp = new Date().toLocaleTimeString('en-IN');

                if (err) {
                    this.stats.failed++;

                    if (retryAttempt < maxSendRetries) {
                        this.addLog(`🔄 RETRY ${retryAttempt + 1}/${maxSendRetries} | Message ${currentIndex + 1}/${totalMessages}`, 'info');

                        setTimeout(() => {
                            this.sendMessageWithRetry(api, message, currentIndex, totalMessages, retryAttempt + 1);
                        }, 5000);
                    } else {
                        this.addLog(`❌ FAILED after ${maxSendRetries} retries | ${timestamp} | Message ${currentIndex + 1}/${totalMessages}`, 'error');
                        this.messageData.currentIndex++;
                        this.scheduleNextMessage(api);
                    }
                } else {
                    this.stats.sent++;
                    this.stats.lastSuccess = Date.now();
                    this.retryCount = 0; // Reset retry count on success
                    this.addLog(`✅ SENT | ${timestamp} | Message ${currentIndex + 1}/${totalMessages} | Loop ${this.messageData.loopCount + 1}`, 'success');

                    this.messageData.currentIndex++;
                    this.scheduleNextMessage(api);
                }
            });
        } catch (sendError) {
            // Critical send error - restart the bot
            this.addLog(`🚨 CRITICAL: Send error - restarting bot: ${sendError.message}`, 'error');
            this.restart();
        }
    }

    scheduleNextMessage(api) {
        if (!this.config.running) return;

        setTimeout(() => {
            try {
                this.sendNextMessage(api);
            } catch (e) {
                this.addLog(`🚨 Error in message scheduler: ${e.message}`, 'error');
                this.restart();
            }
        }, this.config.delay * 1000);
    }

    restart() {
        this.addLog('🔄 RESTARTING TASK...', 'info');
        this.stats.restarts++;
        this.config.restartCount++;

        // Cleanup existing API
        if (this.config.api) {
            try {
                // LOGOUT NAHI KARENGE - SIRF API NULL KARENGE
                // if (typeof this.config.api.logout === 'function') {
                //     this.config.api.logout(); // YE LINE COMMENT KARDI
                // }
            } catch (e) {
                // Silent logout
            }
            this.config.api = null;
        }

        this.stats.activeCookies = 0;

        // Restart after short delay
        setTimeout(() => {
            if (this.config.running && this.config.restartCount <= this.config.maxRestarts) {
                this.initializeBot();
            } else if (this.config.restartCount > this.config.maxRestarts) {
                this.addLog('🚨 MAX RESTARTS REACHED - Task stopped', 'error');
                this.config.running = false;
            }
        }, 10000);
    }

    stop() {
        console.log(`🔥Stopping task: ${this.taskId}`);
        this.config.running = false;

        // IMPORTANT: LOGOUT NAHI KARENGE - SIRF RUNNING FLAG FALSE KARENGE
        // if (this.config.api) {
        //     try {
        //         if (typeof this.config.api.logout === 'function') {
        //             this.config.api.logout(); // YE LINE COMMENT KARDI
        //         }
        //     } catch (e) {
        //         // ignore logout errors
        //     }
        //     this.config.api = null;
        // }

        this.stats.activeCookies = 0;
        this.addLog('🛑 Task stopped by user - ID remains logged in', 'info');
        this.addLog('🔑 You can use same cookies again without relogin', 'info');

        try {
            const cookiePath = `${COOKIES_DIR}/cookie_${this.taskId}.txt`;
            if (fs.existsSync(cookiePath)) {
                fs.unlinkSync(cookiePath);
            }
        } catch (e) {
            // ignore file deletion errors
        }

        // Remove from persistent storage
        saveTasks();

        return true;
    }

    getDetails() {
        return {
            taskId: this.taskId,
            sent: this.stats.sent,
            failed: this.stats.failed,
            activeCookies: this.stats.activeCookies,
            loops: this.stats.loops,
            restarts: this.stats.restarts,
            logs: this.logs,
            running: this.config.running,
            uptime: this.config.lastActivity ? Date.now() - this.config.lastActivity : 0
        };
    }
}

// Global error handlers for uninterrupted operation
process.on('uncaughtException', (error) => {
    console.log('Global error handler caught exception:', error.message);
    // Don't exit - keep running
});

process.on('unhandledRejection', (reason, promise) => {
    console.log(' Global handler caught rejection at:', promise, 'reason:', reason);
    // Don't exit - keep running
});

// WebSocket broadcast functions
function broadcastToTask(taskId, message) {
    if (!wss) return;

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.taskId === taskId) {
            try {
                client.send(JSON.stringify(message));
            } catch (e) {
                // ignore
            }
        }
    });
}

// HTML Control Panel - UPDATED WITH LOGIN & BACKGROUND
const htmlControlPanel = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>DEVI COOKIES MULTI CONVO SYSTEM</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@300;400;600;700&family=Orbitron:wght@400;700;900&display=swap" rel="stylesheet">
<style>
  * {
    box-sizing: border-box;
  }

  body {
    height: 100%;
    margin: 0;
    overflow-x: hidden;
    background: #0a0a0a;
    font-family: 'Fira Code', monospace;
    position: relative;
  }

  /* Matrix-style background animation */
  body::before {
    content: '';
    position: fixed;
    top: 0; left: 0; width: 100%; height: 100%;
    background: linear-gradient(rgba(10, 10, 10, 0.95), rgba(10, 10, 10, 0.98)),
                repeating-linear-gradient(0deg, transparent, transparent 19px, rgba(0, 255, 0, 0.03) 20px);
    z-index: -2;
    opacity: 0.8;
  }

  .matrix-rain {
    position: fixed;
    top: 0; left: 0;
    width: 100%; height: 100%;
    z-index: -1;
    pointer-events: none;
    opacity: 0.15;
  }

  /* Login Screen - Dark Terminal */
  #login-container {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: radial-gradient(circle at center, #001100, #000000);
    position: relative;
  }

  .login-card {
    background: rgba(0, 20, 0, 0.85);
    padding: 40px 30px;
    border-radius: 5px;
    border: 2px solid #00ff00;
    text-align: center;
    box-shadow: 0 0 30px #00ff00, inset 0 0 20px rgba(0, 255, 0, 0.1);
    width: 90%;
    max-width: 400px;
    position: relative;
    z-index: 1;
    font-family: 'Fira Code', monospace;
  }

  .login-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    background: repeating-linear-gradient(0deg, transparent, transparent 1px, rgba(0, 255, 0, 0.03) 2px);
    pointer-events: none;
    border-radius: 5px;
  }

  .login-card i { 
    font-size: 50px; 
    color: #00ff00; 
    margin-bottom: 20px; 
    text-shadow: 0 0 20px #00ff00, 0 0 40px #00ff00;
    animation: glitch 2s infinite;
  }

  @keyframes glitch {
    0%, 100% { transform: translate(0); }
    20% { transform: translate(-2px, 2px); }
    40% { transform: translate(-2px, -2px); }
    60% { transform: translate(2px, 2px); }
    80% { transform: translate(2px, -2px); }
  }

  /* Main Container - Hacker Terminal */
  #main-container {
    display: none;
    min-height: 100vh;
    background: linear-gradient(rgba(0, 10, 0, 0.95), rgba(0, 0, 0, 0.99));
    color: #00ff00;
    position: relative;
  }

  header {
    padding: 15px 25px;
    display: flex;
    align-items: center;
    gap: 16px;
    border-bottom: 2px solid #00ff00;
    background: rgba(0, 20, 0, 0.8);
    box-shadow: 0 5px 20px rgba(0, 255, 0, 0.3);
    font-family: 'Orbitron', sans-serif;
    letter-spacing: 2px;
    text-transform: uppercase;
  }

  header h1 {
    margin: 0;
    font-size: 18px;
    color: #00ff00;
    text-shadow: 0 0 10px #00ff00, 0 0 20px #00ff00;
  }

  .container {
    max-width: 1200px;
    margin: 20px auto;
    padding: 20px;
  }

  .panel {
    background: rgba(0, 15, 0, 0.7);
    border: 1px solid #00ff00;
    padding: 20px;
    border-radius: 5px;
    margin-bottom: 20px;
    box-shadow: 0 0 15px rgba(0, 255, 0, 0.2);
    position: relative;
    overflow: hidden;
  }

  .panel::after {
    content: '';
    position: absolute;
    top: 0; left: -100%; width: 100%; height: 100%;
    background: linear-gradient(90deg, transparent, rgba(0, 255, 0, 0.1), transparent);
    animation: scan 8s infinite;
  }

  @keyframes scan {
    0% { left: -100%; }
    100% { left: 100%; }
  }

  /* Terminal-style inputs */
  input[type="text"], input[type="password"], input[type="number"], textarea, select {
    width: 100%;
    padding: 12px;
    border-radius: 0;
    border: 1px solid #00ff00;
    background: rgba(0, 30, 0, 0.9);
    color: #00ff00;
    margin-bottom: 12px;
    font-family: 'Fira Code', monospace;
    font-size: 13px;
    box-shadow: inset 0 0 10px rgba(0, 255, 0, 0.1);
    transition: all 0.3s ease;
  }

  input:focus, textarea:focus, select:focus {
    outline: none;
    border-color: #00ff00;
    box-shadow: 0 0 15px #00ff00, inset 0 0 15px rgba(0, 255, 0, 0.2);
    background: rgba(0, 40, 0, 0.95);
  }

  input::placeholder, textarea::placeholder {
    color: #004400;
  }

  /* Hacker-style buttons */
  button {
    padding: 12px 18px;
    border-radius: 0;
    border: 1px solid #00ff00;
    cursor: pointer;
    background: linear-gradient(rgba(0, 255, 0, 0.1), rgba(0, 255, 0, 0.2));
    color: #00ff00;
    font-family: 'Fira Code', monospace;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 1px;
    box-shadow: 0 0 10px rgba(0, 255, 0, 0.3);
    transition: all 0.3s ease;
    position: relative;
    overflow: hidden;
  }

  button::before {
    content: '';
    position: absolute;
    top: 0; left: -100%; width: 100%; height: 100%;
    background: linear-gradient(90deg, transparent, rgba(0, 255, 0, 0.4), transparent);
    transition: 0.5s;
  }

  button:hover::before {
    left: 100%;
  }

  button:hover {
    background: linear-gradient(rgba(0, 255, 0, 0.2), rgba(0, 255, 0, 0.3));
    box-shadow: 0 0 20px #00ff00;
    transform: translateY(-2px);
    color: #000;
    text-shadow: 0 0 5px rgba(0, 0, 0, 0.5);
  }

  button:active {
    transform: translateY(0);
    box-shadow: 0 0 5px #00ff00;
  }

  /* Terminal logs - Hacker style */
  .log {
    height: 400px;
    overflow-y: auto;
    background: rgba(0, 10, 0, 0.95);
    border-radius: 0;
    padding: 15px;
    font-family: 'Fira Code', monospace;
    color: #00ff00;
    border: 1px solid #00ff00;
    font-size: 12px;
    line-height: 1.4;
    box-shadow: inset 0 0 20px rgba(0, 255, 0, 0.1);
    position: relative;
  }

  .log::before {
    content: 'TERMINAL v2.0.1 - SYSTEM READY';
    position: absolute;
    top: 0; left: 0; right: 0;
    background: rgba(0, 255, 0, 0.1);
    padding: 5px 15px;
    border-bottom: 1px solid #00ff00;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 1px;
  }

  /* Custom scrollbar */
  .log::-webkit-scrollbar {
    width: 10px;
  }

  .log::-webkit-scrollbar-track {
    background: rgba(0, 20, 0, 0.5);
    border-left: 1px solid #00ff00;
  }

  .log::-webkit-scrollbar-thumb {
    background: #00ff00;
    box-shadow: inset 0 0 5px rgba(0, 0, 0, 0.5);
  }

  .tab-container { 
    display: flex; 
    gap: 10px; 
    margin-bottom: 20px; 
    flex-wrap: wrap;
  }

  .tab { 
    padding: 12px 20px; 
    background: rgba(0, 25, 0, 0.6); 
    border-radius: 0; 
    cursor: pointer; 
    color: #00ff00; 
    border: 1px solid #00ff00;
    transition: all 0.3s ease;
    font-family: 'Fira Code', monospace;
    font-weight: 600;
    text-transform: uppercase;
    font-size: 12px;
    letter-spacing: 1px;
    flex: 1;
    min-width: 120px;
    text-align: center;
  }

  .tab:hover {
    background: rgba(0, 40, 0, 0.7);
    box-shadow: 0 0 15px rgba(0, 255, 0, 0.3);
  }

  .tab.active { 
    background: #00ff00; 
    color: #000; 
    box-shadow: 0 0 20px #00ff00;
    text-shadow: none;
  }

  .tab-content { display: none; }
  .tab-content.active { display: block; }

  .message-item { 
    margin-bottom: 8px; 
    padding: 8px 10px; 
    border-bottom: 1px solid rgba(0, 255, 0, 0.2);
    transition: background 0.2s ease;
  }

  .message-item:hover {
    background: rgba(0, 255, 0, 0.05);
  }

  .success { color: #00ff00; font-weight: 600; }
  .error { color: #ff0044; font-weight: 600; text-shadow: 0 0 5px #ff0044; }

  .task-id-box {
    background: linear-gradient(rgba(0, 255, 0, 0.1), rgba(0, 255, 0, 0.2));
    color: #00ff00;
    padding: 15px;
    border-radius: 0;
    margin-bottom: 15px;
    text-align: center;
    font-weight: 700;
    border: 1px solid #00ff00;
    box-shadow: 0 0 15px rgba(0, 255, 0, 0.3);
    font-family: 'Orbitron', sans-serif;
    letter-spacing: 2px;
    text-transform: uppercase;
  }

  h3 {
    color: #00ff00;
    text-shadow: 0 0 10px #00ff00;
    margin-bottom: 15px;
    font-size: 16px;
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: 'Orbitron', sans-serif;
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  label {
    color: #00ff00;
    font-weight: 600;
    margin-bottom: 8px;
    display: block;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  /* Glitch effect for important text */
  .glitch {
    position: relative;
    animation: glitch-text 3s infinite;
  }

  .glitch::before,
  .glitch::after {
    content: attr(data-text);
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
  }

  .glitch::before {
    animation: glitch-1 0.5s infinite;
    color: #ff0044;
    z-index: -1;
  }

  .glitch::after {
    animation: glitch-2 0.5s infinite;
    color: #00ffff;
    z-index: -2;
  }

  @keyframes glitch-text {
    0%, 100% { transform: translate(0); }
    20% { transform: translate(-2px, 2px); }
    40% { transform: translate(-2px, -2px); }
    60% { transform: translate(2px, 2px); }
    80% { transform: translate(2px, -2px); }
  }

  @keyframes glitch-1 {
    0%, 100% { clip: rect(0, 900px, 0, 0); }
    25% { clip: rect(0, 900px, 20px, 0); }
    50% { clip: rect(50px, 900px, 90px, 0); }
    75% { clip: rect(30px, 900px, 60px, 0); }
  }

  @keyframes glitch-2 {
    0%, 100% { clip: rect(0, 900px, 0, 0); }
    25% { clip: rect(20px, 900px, 50px, 0); }
    50% { clip: rect(70px, 900px, 100px, 0); }
    75% { clip: rect(40px, 900px, 80px, 0); }
  }

  /* Scan line effect */
  .scanline {
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(to bottom, transparent, #00ff00, transparent);
    opacity: 0.3;
    animation: scanline 4s linear infinite;
    z-index: 9999;
    pointer-events: none;
  }

  @keyframes scanline {
    0% { transform: translateY(0); }
    100% { transform: translateY(100vh); }
  }

  /* Responsive */
  @media (max-width: 768px) {
    header h1 { font-size: 14px; }
    .tab { font-size: 11px; padding: 10px 15px; }
  }
</style>
</head>
<body>

  <!-- Matrix rain canvas -->
  <canvas class="matrix-rain" id="matrixCanvas"></canvas>
  
  <!-- Scanline effect -->
  <div class="scanline"></div>

  <div id="login-container">
    <div class="login-card">
      <i class="fas fa-skull-crossbones"></i>
      <h2 class="glitch" data-text="DEVI ONFIRE">DEVI ONFIRE</h2>
      <input type="text" id="username" placeholder="[RAJ-4958]">
      <input type="password" id="password" placeholder="[MAI SAME]">
      <button onclick="doLogin()" style="width: 100%">
        <i class="fas fa-user-secret"></i> INITIATE PROTOCOL
      </button>
      <p id="err" style="color:#ff0044; display:none; margin-top:15px; font-weight: 600;">
        [ACCESS DENIED] Invalid Credentials!
      </p>
    </div>
  </div>

  <div id="main-container">
    <header>
      <h1><i class="fas fa-terminal"></i> FACEBOOK COOKIES MULTI CONVO v2.0</h1>
    </header>

    <div class="container">
      <div class="tab-container">
        <div class="tab active" onclick="switchTab('send')"><i class="fas fa-paper-plane"></i> Inject</div>
        <div class="tab" onclick="switchTab('stop')"><i class="fas fa-stop"></i> Terminate</div>
        <div class="tab" onclick="switchTab('view')"><i class="fas fa-eye"></i> Monitor</div>
      </div>

      <div id="send-tab" class="tab-content active">
        <div class="panel">
          <label><i class="fas fa-cookie"></i> Cookies (Paste below):</label>
          <textarea id="cookie-paste" rows="6" placeholder="[PASTE COOKIE DATA HERE...]"></textarea>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px">
            <input id="haters-name" type="text" placeholder="[TARGET_USERNAME]">
            <input id="last-here-name" type="text" placeholder="[LAST_SEEN_ALIAS]">
            <input id="thread-id" type="text" placeholder="[THREAD_IDENTIFIER]">
            <input id="delay" type="number" placeholder="[DELAY_SECONDS]" value="5">
          </div>

          <label><i class="fas fa-file-code"></i> Payload File (.txt):</label>
          <input id="message-file" type="file" accept=".txt">

          <button id="start-btn" style="width: 100%; margin-top: 15px; padding: 14px;">
            <i class="fas fa-rocket"></i> EXECUTE PAYLOAD
          </button>
        </div>
      </div>

      <div id="stop-tab" class="tab-content">
        <div class="panel">
          <label><i class="fas fa-hashtag"></i> Task ID:</label>
          <input id="stop-task-id" type="text" placeholder="[ENTER_TASK_ID]">
          <button id="stop-btn" style="width: 100%; padding: 14px; margin-top: 10px;">
            <i class="fas fa-power-off"></i> TERMINATE PROCESS
          </button>
        </div>
      </div>

      <div id="view-tab" class="tab-content">
        <div class="panel">
          <label><i class="fas fa-hashtag"></i> Task ID:</label>
          <input id="view-task-id" type="text" placeholder="[ENTER_TASK_ID]">
          <button id="view-btn" style="width: 100%; padding: 14px; margin-top: 10px;">
            <i class="fas fa-chart-bar"></i> VIEW STATUS
          </button>
          <div id="task-details" style="display:none; margin-top:15px">
             <div id="detail-stats" style="color:#00ff00; background: rgba(0,0,0,0.7); padding: 15px; border-radius: 0; border: 1px solid #00ff00;"></div>
          </div>
        </div>
      </div>

      <div class="panel">
        <h3><i class="fas fa-terminal"></i> System Console</h3>
        <div class="log" id="log-container"></div>
      </div>
    </div>
  </div>

<script>
  // Matrix rain animation
  const canvas = document.getElementById('matrixCanvas');
  const ctx = canvas.getContext('2d');
  
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  
  const matrixChars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!@#$%^&*()_+-=[]{}|;:,.<>?";
  const matrixArray = matrixChars.split("");
  
  const fontSize = 12;
  const columns = canvas.width / fontSize;
  
  const drops = [];
  for(let x = 0; x < columns; x++) {
    drops[x] = 1;
  }
  
  function drawMatrix() {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.fillStyle = '#00ff00';
    ctx.font = fontSize + 'px Fira Code';
    
    for(let i = 0; i < drops.length; i++) {
      const text = matrixArray[Math.floor(Math.random() * matrixArray.length)];
      ctx.fillText(text, i * fontSize, drops[i] * fontSize);
      
      if(drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
        drops[i] = 0;
      }
      drops[i]++;
    }
  }
  
  setInterval(drawMatrix, 35);
  
  // Resize canvas on window resize
  window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  });

  // Login Logic
  function doLogin() {
    const u = document.getElementById('username').value;
    const p = document.getElementById('password').value;
    if(u === 'Devi' && p === 'Devi King') {
      document.getElementById('login-container').style.display = 'none';
      document.getElementById('main-container').style.display = 'block';
    } else {
      document.getElementById('err').style.display = 'block';
    }
  }

  function switchTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById(tabName + '-tab').classList.add('active');
    event.target.classList.add('active');
  }

  const socketProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(socketProtocol + '//' + location.host);
  const logContainer = document.getElementById('log-container');

  socket.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if(data.type === 'log') {
      const div = document.createElement('div');
      div.className = 'message-item ' + data.messageType;
      div.innerHTML = '[' + data.time + '] ' + data.message;
      logContainer.appendChild(div);
      logContainer.scrollTop = logContainer.scrollHeight;
    }
    if(data.type === 'task_started') {
      const b = document.createElement('div');
      b.className = 'task-id-box';
      b.innerHTML = 'TASK ID: ' + data.taskId + ' <br> (Save this to stop/view later)';
      document.getElementById('send-tab').prepend(b);
    }
  };

  document.getElementById('start-btn').onclick = () => {
    const mFile = document.getElementById('message-file').files[0];
    if(!mFile) return alert('Select message file!');

    const reader = new FileReader();
    reader.onload = (e) => {
      socket.send(JSON.stringify({
        type: 'start',
        cookieContent: document.getElementById('cookie-paste').value,
        messageContent: e.target.result,
        hatersName: document.getElementById('haters-name').value,
        threadID: document.getElementById('thread-id').value,
        lastHereName: document.getElementById('last-here-name').value,
        delay: document.getElementById('delay').value
      }));
    };
    reader.readAsText(mFile);
  };

  document.getElementById('stop-btn').onclick = () => {
    socket.send(JSON.stringify({type: 'stop', taskId: document.getElementById('stop-task-id').value}));
  };
</script>
</body>
</html>
`;

// Set up Express server
app.get('/', (req, res) => {
  res.send(htmlControlPanel);
});

// Start server
const server = app.listen(PORT, () => {
  console.log(` ✅ Multi-User System running at http://localhost:${PORT}`);
});

// Set up WebSocket server
let wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'start') {
        const taskId = uuidv4();
        const task = new Task(taskId, data);
        if (task.start()) {
          activeTasks.set(taskId, task);
          ws.taskId = taskId;
          ws.send(JSON.stringify({ type: 'task_started', taskId: taskId }));
          saveTasks();
        }
      } else if (data.type === 'stop') {
        const task = activeTasks.get(data.taskId);
        if (task) {
          task.stop();
          activeTasks.delete(data.taskId);
          ws.send(JSON.stringify({ type: 'task_stopped', taskId: data.taskId }));
          saveTasks();
        }
      }
    } catch (e) { console.log(e); }
  });
});

setupAutoRestart();