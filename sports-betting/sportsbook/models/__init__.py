from .mlb import MLBModel
from .nba import NBAModel
from .ncaab import NCAABModel
from .nfl import NFLModel

MODELS = {
    "NFL": NFLModel,
    "NBA": NBAModel,
    "MLB": MLBModel,
    "NCAAB": NCAABModel,
}
