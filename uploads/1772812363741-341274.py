"""Smart Home AI Assistant - Core Engine"""
import asyncio
from fastapi import FastAPI, WebSocket
from tensorflow import keras
import numpy as np

app = FastAPI(title="Smart Home AI Assistant")

class EnergyPredictor:
    """ML model for energy consumption prediction and optimization."""
    
    def __init__(self):
        self.model = self._build_model()
        self.history = []
    
    def _build_model(self):
        model = keras.Sequential([
            keras.layers.Dense(128, activation='relu', input_shape=(24,)),
            keras.layers.Dropout(0.2),
            keras.layers.Dense(64, activation='relu'),
            keras.layers.Dense(32, activation='relu'),
            keras.layers.Dense(1, activation='sigmoid')
        ])
        model.compile(optimizer='adam', loss='mse', metrics=['mae'])
        return model
    
    def predict_usage(self, hourly_data):
        """Predict next-hour energy usage based on 24h pattern."""
        data = np.array(hourly_data).reshape(1, -1)
        return float(self.model.predict(data, verbose=0)[0][0])
    
    def optimize_schedule(self, devices, preferences):
        """Generate optimal device schedule to minimize energy waste."""
        schedule = {}
        for device in devices:
            predicted = self.predict_usage(device['usage_history'])
            if predicted < preferences.get('threshold', 0.5):
                schedule[device['id']] = 'standby'
            else:
                schedule[device['id']] = 'active'
        return schedule

predictor = EnergyPredictor()

@app.get("/api/status")
async def get_status():
    return {"status": "running", "devices_connected": 42, "energy_saved_today": "2.4 kWh"}

@app.post("/api/predict")
async def predict_energy(data: dict):
    prediction = predictor.predict_usage(data['hourly_readings'])
    return {"predicted_usage": prediction, "recommendation": "optimal" if prediction < 0.6 else "reduce"}

@app.websocket("/ws/dashboard")
async def dashboard_ws(websocket: WebSocket):
    await websocket.accept()
    while True:
        data = await websocket.receive_json()
        prediction = predictor.predict_usage(data.get('readings', [0]*24))
        await websocket.send_json({"prediction": prediction, "timestamp": "now"})
