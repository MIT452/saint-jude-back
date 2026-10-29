# models/demand_forecaster.py
from prophet import Prophet
import pandas as pd
from datetime import datetime, timedelta

class DemandForecaster:
    def __init__(self):
        self.model = None

    def prepare_data(self, reservations: list) -> pd.DataFrame:
        """
        Transforme les réservations en série journalière.
        reservations = [{"date": "2026-10-15", "count": 3}, ...]
        """
        df = pd.DataFrame(reservations)
        df["ds"] = pd.to_datetime(df["date"])
        df["y"] = df["count"]
        return df[["ds", "y"]].sort_values("ds")

    def train(self, df: pd.DataFrame):
        self.model = Prophet(
            yearly_seasonality=True,
            weekly_seasonality=True,
            daily_seasonality=False,
            seasonality_mode="multiplicative"
        )
        self.model.fit(df)

    def predict(self, periods: int = 30) -> list:
        future = self.model.make_future_dataframe(periods=periods)
        forecast = self.model.predict(future)
        
        # On ne garde que les jours futurs
        last_date = self.model.history["ds"].max()
        future_only = forecast[forecast["ds"] > last_date]
        
        return [
            {
                "date": row["ds"].strftime("%Y-%m-%d"),
                "prevision": round(max(0, row["yhat"]), 1),
                "basse": round(max(0, row["yhat_lower"]), 1),
                "haute": round(max(0, row["yhat_upper"]), 1)
            }
            for _, row in future_only.iterrows()
        ]